const cheerio = require('cheerio');
const request = require('request-promise');
const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const iso88592 = require('iso-8859-2');

const TEAM_NAME = "Lech Poznań";
const LEAGUE_SCHEDULE_URL = "http://ekstraklasa.org/rozgrywki/terminarz/ekstraklasa-4";
const CUP_SCHEDULE_URL = "https://www.laczynaspilka.pl/rozgrywki/puchar-polski,38528.html?round=0";
const EUROPA_LEAGUE_URL = "http://www.90minut.pl/liga/1/liga11239.html";
const CHAMPIONS_LEAGUE_URL = "http://www.90minut.pl/liga/1/liga11238.html";
const CURRENT_SEASON_THRESHOLD_DATE = new Date(2020, 07, 01);

const CALENDAR_ID = "9kqm5kqf901bd7tt5f1fg49cfs@group.calendar.google.com";
const HOME_GAME_ADDRESS = "INEA Stadion, Bułgarska, Poznań";
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const TOKEN_PATH = 'token.json';
const DEBUG = false;

function isset(accessor){
    try {
        return typeof accessor() !== 'undefined'
    } catch (e) {
        return false
    }
}

function log(text){
    fs.appendFileSync('log.log',new Date().toISOString() + ' :: ' + text+'\n');
    console.log(text);
}

if (!Array.prototype.flat) {
    Array.prototype.flat = function(depth) {
        var flattend = [];
        (function flat(array, depth) {
            for (let el of array) {
                if (Array.isArray(el) && depth > 0) {
                    flat(el, depth - 1);
                } else {
                    flattend.push(el);
                }
            }
        })(this, Math.floor(depth) || 1);
        return flattend;
    };
}

async function authGoogleCalendar(){
    let credentials = JSON.parse(fs.readFileSync('credentials.json'));
    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    try{
        let token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    }
    catch(err){
        return await getAccessToken(oAuth2Client);
    }
}


async function getAccessToken(oAuth2Client) {
    return new Promise((resolve,reject)=>{
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });
        console.log('Authorize this app by visiting this url:', authUrl);
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question('Enter the code from that page here: ', (code) => {
            rl.close();
            oAuth2Client.getToken(code, (err, token) => {
                if (err) return reject(err);
                oAuth2Client.setCredentials(token);
                // Store the token to disk for later program executions
                fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
                    if (err) return reject(err);
                    console.log('Token stored to', TOKEN_PATH);
                });
                resolve(oAuth2Client);
            });
        });
    });
}

async function addMatch(auth,match,calendarMatches) {
    return new Promise((resolve,reject)=>{
        let calendarMatch = undefined;
        let i = 0;
        for(;i<calendarMatches.length;i++){
            if(calendarMatches[i].summary.toLocaleLowerCase().startsWith(match.title.toLocaleLowerCase())){
                calendarMatch = calendarMatches[i];
                break;
            }
        }
        let event = createNewMatchEvent(match);
        if(isset(()=>calendarMatch)){
            let same = (calendarMatch.summary === event.summary && ((isset(()=>event.start.dateTime) && Date.parse(calendarMatch.start.dateTime) === Date.parse(event.start.dateTime)) || !isset(()=>event.start.dateTime)) && ((isset(()=>event.end.dateTime) && Date.parse(calendarMatch.end.dateTime) === Date.parse(event.end.dateTime)) || !isset(()=>event.end.dateTime)));
            if(!same){
                //update match event
                log("Updating match: " + match.title);
                calendarMatch.summary = event.summary;
                if(isset(()=>event.start.dateTime))
                    calendarMatch.start = event.start;
                if(isset(()=>event.end.dateTime))
                    calendarMatch.end = event.end;
                google.calendar({version: 'v3', auth}).events.update({
                    auth: auth,
                    calendarId: CALENDAR_ID,
                    eventId: calendarMatch.id,
                    resource: calendarMatch,
                }, function(err, event) {
                    calendarMatches.splice(i, 1);
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            }
            else{
                //no update needed
                calendarMatches.splice(i, 1);
                resolve();
            }
        }
        else{
            //new match event needed
            log("Adding new match: " + match.title);
            google.calendar({version: 'v3', auth}).events.insert({
                auth: auth,
                calendarId: CALENDAR_ID,
                resource: event,
            }, function(err, event) {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        }
    });
}

async function deleteMatch(auth, match){
    return new Promise((resolve,reject)=>{
        log("Removing match: " + match.summary);
        google.calendar({version: 'v3', auth}).events.delete({
            auth: auth,
            calendarId: CALENDAR_ID,
            eventId: match.id
        }, function(err, event) {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}

function createNewMatchEvent(matchEntry){
    const MATCH_TIME = 2;//hours
    let ret = {
        'summary': matchEntry.title,
        'start': {},
        'end': {}
    };
    if(isset(()=>matchEntry.score)){
        ret.summary += ' ('+matchEntry.score+')';
    }
    if(isset(()=>matchEntry.dateTime)){
        //precise time known
        ret.start.dateTime = matchEntry.dateTime.toISOString();
        stop = new Date(matchEntry.dateTime);
        stop.setHours(matchEntry.dateTime.getHours() + MATCH_TIME);
        ret.end.dateTime = stop.toISOString();
    }
    else{
        //time not known
        ret.start.date = matchEntry.date;
        ret.end.date = matchEntry.date;
    }
    if(ret.summary.split('-')[0].toLocaleLowerCase().includes(TEAM_NAME.toLocaleLowerCase())){
        //home game, add location
        ret.location = HOME_GAME_ADDRESS;
    }
    return ret;
}

async function getCalendarMatches(auth){
    return new Promise((resolve,reject)=>{
        google.calendar({version: 'v3', auth}).events.list({
            auth: auth,
            calendarId: CALENDAR_ID,
            timeMin: CURRENT_SEASON_THRESHOLD_DATE.toISOString()
        }, function(err, res) {
            if (err) {
                return reject(err);
            }
            resolve(res.data.items);
        });
    })
}

async function main(){
    let auth, calendarMatches;
    log("-------------------------------------------------------");
    if(!DEBUG){
        log("Logging in to Google Calendar...");
        auth = await authGoogleCalendar();
        log("Obtaining matches from calendar...");
        calendarMatches = await getCalendarMatches(auth);    
    }
    else{
        log("Debug run, not connecting to Google Calendar")
    }
    log("Getting matches schedule...");
    const schedule = await getMatches();
    if(!DEBUG){
        log("Setting schedule in calendar...");
        for(match of schedule){
            await addMatch(auth,match,calendarMatches);
        }
    }
    else{
        console.log("Found following matches:");
        console.log(schedule);
    }
    if(calendarMatches.length){
        log("Found >>"+calendarMatches.length+"<< matches to be removed...");
        for(match of calendarMatches){
            await deleteMatch(auth,match);
        }
    }
    log("Finished!");
}

try{
    main();
}
catch(err){
    log("ERROR:")
    log(JSON.stringify(err));
}

async function getMatches(){
    return (await Promise.all([
        getLeagueMatchesSchedule(),
        getCupMatchesSchedule(),
        getELMatches()
    ])).flat();
}

async function getLeagueMatchesSchedule(){
    log("Getting league matches schedule...");
    try{
        let schedule = await request.get(LEAGUE_SCHEDULE_URL);
        let $ = cheerio.load(schedule);
        let matches = [];
        $('table.contestPart tbody tr td.team div.hidden-xs').filter(function(){
            return $(this).text().toLocaleLowerCase() === TEAM_NAME.toLocaleLowerCase();
        }).each(function(){
            let matchRow = $(this).closest("tr");
            let teams = matchRow.find('td.team div.hidden-xs').map(function(){return $(this).text().trim()});
            let score = matchRow.find('td.hour div.scorecont div.score').map(function(){return $(this).text().trim()});
            if(score.length){
                //past game with score
                let date = matchRow.find('td.date-short').text().trim().split('.');
                matches.push({
                    title:      teams[0] + ' - ' + teams[1],
                    score:      score[0] + ':' + score[1],
                    date:       date[2]+'-'+date[1]+'-'+date[0]
                })
            }
            else{
                //upcoming game without score
                let date = matchRow.find('td.date-short div.hidden-sm').text().trim().split('.');
                if(date.length === 3){
                    if(matchRow.find('div.hour').length){
                        //hour available
                        let hour = matchRow.find('div.hour').text().trim().split(':');
                        matches.push({
                            title:      teams[0] + ' - ' + teams[1],
                            dateTime:   new Date(date[2],parseInt(date[1])-1,date[0],hour[0],hour[1])
                        })
                    }
                    else{
                        //no hour available
                        matches.push({
                            title:      teams[0] + ' - ' + teams[1],
                            date:       date[2]+'-'+date[1]+'-'+date[0]
                        })
                    }
                }
            }
        });
        return matches;
    }
    catch(error){
        log("Error occured while querying league matches:");
        log(error);
        return [];
    }
}

async function getCupMatchesSchedule(){
    log("Getting cup matches schedule...");
    try{
        let schedule = await request.get(CUP_SCHEDULE_URL);
        let $ = cheerio.load(schedule);
        let matches = [];
        $('.season__games .season__game .team').filter(function(){
            return $(this).text().toLocaleLowerCase().includes(TEAM_NAME.toLocaleLowerCase());
        }).each(function(){
            let matchRow = $(this).closest('.season__game');
            let teams = matchRow.find('div.teams a.team').map(function(){return $(this).text().trim()});
            let score = matchRow.find('span.score').text().trim();
            let date = matchRow.find('div.season__game-data .month').text().split('/');
            let time = matchRow.find('div.season__game-data .hour').text().split(':');
            date = new Date(date[1],parseInt(date[0])-1,matchRow.find('div.season__game-data .day').text(),time[0],time[1]);
            if(score.length){
                //past game with score
                matches.push({
                    title:      teams[0] + ' - ' + teams[1] + ' [PP]',
                    score:      score,
                    dateTime:   date
                })
            }
            else{
                //upcoming game without score
                matches.push({
                    title:      teams[0] + ' - ' + teams[1] + ' [PP]',
                    dateTime:   date
                })
            }
        });
        return matches;
    }
    catch(error){
        log("Error occured while querying cup matches:");
        log(error);
        return [];
    }
}

async function getELMatches(){
    log("Getting Europa League matches schedule...");
    try{
        let schedule = await request.get({
            uri: EUROPA_LEAGUE_URL,
            encoding: null
        });
        schedule = iso88592.decode(schedule.toString('binary'));
        let $ = cheerio.load(schedule);
        let matches = [];
        let prevDate = CURRENT_SEASON_THRESHOLD_DATE;
        $('table.main tr').filter(function(){
            return $(this).text().toLocaleLowerCase().includes(TEAM_NAME.toLocaleLowerCase());
        }).each(function(){
            try{
                const cells = $(this).find('td');
                let dateString = $(cells[5]).text().trim();
                if(dateString !== ''){
                    const date = parse90MinutDate($(cells[5]).text().trim(), prevDate);
                    prevDate = date;
                    let teamH = $(cells[1]).text().trim();
                    teamH = teamH===''?'???':teamH;
                    let teamA = $(cells[3]).text().trim();
                    teamA = teamA===''?'???':teamA;
                    let score = $(cells[2]).text().trim()
                    if(score === '-'){
                        //match with no score
                        matches.push({
                            title:      teamH + ' - ' + teamA + ' [Liga Europy]',
                            dateTime:   date
                        });
                    }
                    else{
                        //match with score
                        matches.push({
                            title:      teamH + ' - ' + teamA + ' [Liga Europy]',
                            dateTime:   date,
                            score:      score.replace('-',':')
                        });
                    }
                }
            }
            catch(error){
                log("Error occured while querying Europa League match, probably future potential match not ready yet");
                log(error);
            }
        })
        return matches;
    }
    catch(error){
        log("Error occured while querying Europa League matches:");
        log(error);
        return [];
    }
}

function parse90MinutDate(dateString, prevDate){
    if(typeof prevDate === 'undefined'){
        prevDate = new Date();
        prevDate.setMonth(0,1);
    }
    let ret = new Date(prevDate.getTime());
    let dateParts = dateString.split(' ');
    ret.setDate(parseInt(dateParts[0]))
    const months = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
    let success = false;
    for(let month = 0; month < months.length; month++){
        if(dateParts[1].startsWith(months[month])){
            ret.setMonth(month);
            success = true;
            break;
        }
    }
    if(!success){
        throw new Error("Month not found!");
    }
    let timeParts = dateParts[2].split(':');
    ret.setHours(parseInt(timeParts[0]),parseInt(timeParts[1]),0,0);
    if(ret < prevDate){
        ret.setFullYear(ret.getFullYear()+1);
    }
    return ret;
}