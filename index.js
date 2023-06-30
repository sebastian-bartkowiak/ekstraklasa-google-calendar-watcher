const cheerio = require('cheerio');
const request = require('request-promise');
const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const iso88592 = require('iso-8859-2');

const TEAM_NAME = "Lech Poznań";
const LEAGUE_SCHEDULE_URL = "http://www.90minut.pl/liga/1/liga12904.html";
const CUP_SCHEDULE_URL = "http://www.90minut.pl/liga/1/liga12908.html";
const EUROPEAN_CUP_URL = "http://www.90minut.pl/liga/1/liga12911.html";
const CURRENT_SEASON_START_DATE = new Date(2023, 06, 01);
let CURRENT_SEASON_STOP_DATE = new Date(CURRENT_SEASON_START_DATE.getTime())
CURRENT_SEASON_STOP_DATE.setFullYear(CURRENT_SEASON_STOP_DATE.getFullYear()+1)

const CALENDAR_ID = "9kqm5kqf901bd7tt5f1fg49cfs@group.calendar.google.com";
const HOME_GAME_ADDRESS = "INEA Stadion, Bułgarska, Poznań";
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const TOKEN_PATH = __dirname+'\\token.json';
const DEBUG = false;

function isset(accessor){
    try {
        return typeof accessor() !== 'undefined'
    } catch (e) {
        return false
    }
}

function log(text){
    fs.appendFileSync(__dirname+'\\log.log',new Date().toISOString() + ' :: ' + text+'\n');
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
    let credentials = JSON.parse(fs.readFileSync(__dirname+'\\credentials.json'));
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

function dashedDateParse(datestring){
    try{
        if(datestring.match(/^\d{4}\-\d{1,2}\-\d{1,2}$/)){
            const elements = datestring.split('-')
            if(elements.length === 3){
                return new Date(elements[0]*1, (elements[1]*1)-1, elements[2]*1).getTime()
            }
        }
        return Date.parse(datestring)
    }
    catch(e){
        return Date.parse(datestring)
    }
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
            let same = (
                calendarMatch.summary === event.summary &&
                (
                    (
                        isset(()=>event.start.dateTime) &&
                        dashedDateParse(calendarMatch.start.dateTime) === dashedDateParse(event.start.dateTime)
                    ) ||
                    !isset(()=>event.start.dateTime)
                ) &&
                (
                    (
                        isset(()=>event.end.dateTime) &&
                        dashedDateParse(calendarMatch.end.dateTime) === dashedDateParse(event.end.dateTime)
                    ) ||
                    !isset(()=>event.end.dateTime)
                ) &&
                (
                    (
                        isset(()=>event.start.date) &&
                        dashedDateParse(calendarMatch.start.date) === dashedDateParse(event.start.date)
                    ) ||
                    !isset(()=>event.start.date)
                ) &&
                (
                    (
                        isset(()=>event.end.date) &&
                        dashedDateParse(calendarMatch.end.date) === dashedDateParse(event.end.date)
                    ) ||
                    !isset(()=>event.end.date)
                )
            );
            if(!same){
                //update match event
                log("Updating match: " + match.title);
                calendarMatch.summary = event.summary;
                calendarMatch.start = event.start;
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
        let plusOne = new Date(matchEntry.date)
        plusOne.setDate(plusOne.getDate() + 1)
        ret.start.date = matchEntry.date;
        ret.end.date = `${plusOne.getFullYear()}-${plusOne.getMonth()+1}-${plusOne.getDate()}`;
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
            timeMin: CURRENT_SEASON_START_DATE.toISOString()
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
        if(calendarMatches.length){
            log("Found >>"+calendarMatches.length+"<< matches to be removed...");
            for(match of calendarMatches){
                await deleteMatch(auth,match);
            }
        }
    }
    else{
        console.log("Found following matches:");
        console.log(schedule);
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
        let schedule = await request.get({
            uri: LEAGUE_SCHEDULE_URL,
            encoding: null
        });
        schedule = iso88592.decode(schedule.toString('binary'));
        let $ = cheerio.load(schedule);
        let matches = [];
        let prevDate = CURRENT_SEASON_START_DATE;
        $('table.main tr').filter(function(){
            return $(this).text().toLocaleLowerCase().includes(TEAM_NAME.toLocaleLowerCase());
        }).each(function(){
            try{
                const cells = $(this).find('td');
                let dateString = $(cells[3]).text().trim();
                let teamH = $(cells[0]).text().trim();
                teamH = teamH===''?'???':teamH;
                let teamA = $(cells[2]).text().trim();
                teamA = teamA===''?'???':teamA;
                if(teamH.toLocaleLowerCase() === TEAM_NAME.toLocaleLowerCase() || teamA.toLocaleLowerCase() === TEAM_NAME.toLocaleLowerCase()){
                    if(dateString !== ''){
                        const date = parse90MinutDate(dateString, prevDate);
                        prevDate = date;
                        let score = $(cells[1]).text().trim()
                        if(score === '-'){
                            //match with no score
                            matches.push({
                                title:      teamH + ' - ' + teamA,
                                dateTime:   date
                            });
                        }
                        else{
                            //match with score
                            matches.push({
                                title:      teamH + ' - ' + teamA,
                                score:      score.replace('-',':'),
                                dateTime:   date
                            });
                        }
                    }
                    else{
                        //upcoming match, no hour yet
                        let roundDate = $(this).closest('p').prev().text().trim().toLocaleLowerCase()
                        let dashPos = roundDate.indexOf('-')
                        if(roundDate.startsWith('kolejka') && dashPos !== -1){
                            roundDate = roundDate.substring(dashPos + 2)
                            const singleMonthRegex = /^(\d{1,2})(-\d{1,2})?(\s[^-]+?)$/
                            const singleMatch = roundDate.match(singleMonthRegex)
                            const dualMonthRegex = /^(\d{1,2}\s[^-]+?)-\d{1,2}\s[^-]+?$/
                            const dualMatch = roundDate.match(dualMonthRegex)
                            if(singleMatch !== null){
                                roundDate = singleMatch[1]+singleMatch[3]
                            }
                            else if(dualMatch !== null){
                                roundDate = dualMatch[1]
                            }
                            else{
                                log("Error occured while querying league match, date does not match any format");
                            }
                            const date = parse90MinutDate(roundDate, prevDate);
                            prevDate = date;
                            matches.push({
                                title:      teamH + ' - ' + teamA,
                                date:       date.getFullYear()+'-'+(date.getMonth()+1)+'-'+date.getDate()
                            })
                        }
                    }
                }
            }
            catch(error){
                log("Error occured while querying league match");
                log(error);
            }
        })
        return matches;
    }
    catch(error){
        log("Error occured while querying league matches:");
        log(error);
        return [];
    }
}

async function getCupMatchesSchedule(){
    if(typeof CUP_SCHEDULE_URL === 'undefined'){
        log("Skipped getting cup matches schedule, because no url defined");
        return [];
    }
    log("Getting cup matches schedule...");
    try{
        let schedule = await request.get({
            uri: CUP_SCHEDULE_URL,
            encoding: null
        });
        schedule = iso88592.decode(schedule.toString('binary'));
        let $ = cheerio.load(schedule);
        let matches = [];
        let prevDate = CURRENT_SEASON_START_DATE;
        $('table.main tr').filter(function(){
            return $(this).text().toLocaleLowerCase().includes(TEAM_NAME.toLocaleLowerCase());
        }).each(function(){
            try{
                const cells = $(this).find('td');
                let dateString = $(cells[3]).text().trim();
                let teamH = $(cells[0]).text().trim();
                teamH = teamH===''?'???':teamH;
                let teamA = $(cells[2]).text().trim();
                teamA = teamA===''?'???':teamA;
                if(dateString !== ''){
                    const date = parse90MinutDate(dateString, prevDate);
                    prevDate = date;
                    let score = $(cells[1]).text().trim()
                    if(score === '-'){
                        //match with no score
                        matches.push({
                            title:      teamH + ' - ' + teamA + ' [PP]',
                            dateTime:   date
                        });
                    }
                    else{
                        //match with score
                        matches.push({
                            title:      teamH + ' - ' + teamA + ' [PP]',
                            score:      score.replace('-',':'),
                            dateTime:   date
                        });
                    }
                }
                else{
                    //upcoming match, no hour yet
                    //TODO
                    log("Found upcoming cup match with no hour, skipping for now...");
                }
            }
            catch(error){
                log("Error occured while querying cup match");
                log(error);
            }
        })
        return matches;
    }
    catch(error){
        log("Error occured while querying cup matches:");
        log(error);
        return [];
    }
}

async function getELMatches(){
    if(typeof EUROPEAN_CUP_URL === 'undefined'){
        log("Skipped getting European Cup matches schedule, because no url defined");
        return [];
    }
    log("Getting European Cup matches schedule...");
    try{
        let schedule = await request.get({
            uri: EUROPEAN_CUP_URL,
            encoding: null
        });
        schedule = iso88592.decode(schedule.toString('binary'));
        let $ = cheerio.load(schedule);
        let matches = [];
        let prevDate = CURRENT_SEASON_START_DATE;
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
                            title:      teamH + ' - ' + teamA + ' [Liga Konferencji Europy]',
                            dateTime:   date
                        });
                    }
                    else{
                        //match with score
                        matches.push({
                            title:      teamH + ' - ' + teamA + ' [Liga Konferencji Europy]',
                            dateTime:   date,
                            score:      score.replace('-',':')
                        });
                    }
                }
            }
            catch(error){
                log("Error occured while querying European Cup match, probably future potential match not ready yet");
                log(error);
            }
        })
        return matches;
    }
    catch(error){
        log("Error occured while querying European Cup matches:");
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
    if(typeof dateParts[2] !== 'undefined'){
        let timeParts = dateParts[2].split(':');
        ret.setHours(parseInt(timeParts[0]),parseInt(timeParts[1]),0,0);
    }
    if(ret < prevDate){
        ret.setFullYear(ret.getFullYear()+1);
    }
    if(ret > CURRENT_SEASON_STOP_DATE){
        ret.setFullYear(ret.getFullYear()-1);
    }
    return ret;
}