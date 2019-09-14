const cheerio = require('cheerio');
const request = require('request-promise');
const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');

const TEAM_NAME = "Lech Poznań";
const SCHEDULE_URL = "http://ekstraklasa.org/rozgrywki/terminarz/ekstraklasa-3";
const CALENDAR_ID = "9kqm5kqf901bd7tt5f1fg49cfs@group.calendar.google.com";
const HOME_GAME_ADDRESS = "INEA Stadion, Bułgarska, Poznań";
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const TOKEN_PATH = 'token.json';

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

async function getMatchesSchedule(){
    let schedule = await request.get(SCHEDULE_URL);
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
    });
    return matches;
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
        for(let i=0;i<calendarMatches.length;i++){
            if(calendarMatches[i].summary.toLocaleLowerCase().startsWith(match.title.toLocaleLowerCase())){
                calendarMatch = calendarMatches[i];
                break;
            }
        }
        let event = createNewMatchEvent(match);
        if(isset(()=>calendarMatch)){
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
                if (err) {
                    return reject(err);
                }
                resolve();
            });
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
    if(ret.summary.toLocaleLowerCase().startsWith(TEAM_NAME.toLocaleLowerCase())){
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
        }, function(err, res) {
            if (err) {
                return reject(err);
            }
            resolve(res.data.items);
        });
    })
}

async function main(){
    log("Logging in to Google Calendar...");
    let auth = await authGoogleCalendar();
    log("Obtaining matches from calendar...");
    let calendarMatches = await getCalendarMatches(auth);
    log("Getting matches schedule...");
    let schedule = await getMatchesSchedule();
    log("Setting schedule in calendar...");
    for(match of schedule){
        await addMatch(auth,match,calendarMatches);
    }
    log("Finished!");
}

main();