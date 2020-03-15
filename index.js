'use strict';

const http = require('http');
const qs = require('querystring');
// const {google} = require('googleapis'); // Add "googleapis": "^33.0.0", to package.json 'dependencies' when you enable this again.
const request = require('request');
const moment = require('moment');
var gapi_helper = require("./googleapi_helper.js");
var rp = require('request-promise');
var date = require('date-and-time');

const util = require('util');
const setTimeoutPromise = util.promisify(setTimeout);

function createInitialMessage(incidentName, slackUserName, incidentSlackChannel, incidentSlackChannelId) {
    // Prepare a rich Slack message
    // See https://api.slack.com/docs/message-formatting
    var slackMessage = {
        username: 'Coffee Break',
        icon_emoji: ':coffee:',
        attachments: [],
        link_names: true,
        parse: 'full',
    };

    slackMessage.attachments.push({
        color: '#8f0000',
        title: incidentName,
        text: "Coffee Channel: #" + incidentSlackChannel,
        "fallback": "Join Coffee Channel #" + incidentSlackChannel,
        "actions": [
            {
                "type": "button",
                "text": "Join Coffee Break",
                "url": "slack://channel?team=" + process.env.SLACK_TEAM_ID + "&id=" + incidentSlackChannelId,
                "style": "primary"
            }
        ],
        footer: `coffee break needed by @${slackUserName}`
    });
    return slackMessage;
}

function sendIncidentLogFileToChannel(incidentSlackChannelId, docUrl) {
    var slackMessage = {
        username: 'During the incident',
        icon_emoji: ':pencil:',
        channel: '',
        attachments: [],
        link_names: true,
        parse: 'full',
    };

    // Google Doc
    slackMessage.attachments.push({
        color: '#3367d6',
        title: 'Notes & Actions',
        title_link: docUrl,
        text: docUrl,
        footer: 'Use this document to to maintain a timeline of key events during an incident. Document actions, and keep track of any followup items that will need to be addressed.'
    });
    sendSlackMessageToChannel(incidentSlackChannelId, slackMessage);
}

function sendEpicToChannel(incidentSlackChannelId, epicUrl) {
    var slackMessage = {
        username: 'After the incident',
        icon_emoji: ':dart:',
        channel: '',
        attachments: [],
        link_names: true,
        parse: 'full',
    };
    // Epic link
    slackMessage.attachments.push({
        color: '#FD6A02',
        title: 'Discuss and track follow-up actions',
        title_link: epicUrl,
        text: epicUrl,
        footer: 'Remember: Don\'t Neglect the Post-Mortem!'
    });
    sendSlackMessageToChannel(incidentSlackChannelId, slackMessage);
}

function sendConferenceCallDetailsToChannel(incidentSlackChannelId, eventDetails) {
    var entryPoints = eventDetails.data.conferenceData.entryPoints;
    var title_link;
    var text;
    var more_phones_link;
    var tel;
    var tel_link;
    var pin;
    var regionCode;
    for (var i = 0; i < entryPoints.length; i++) {
        var entryPoint = entryPoints[i];
        var type = entryPoint.entryPointType;
        if (type == 'video') {
            title_link = entryPoint.uri;
            text = entryPoint.label;
        }
        if (type == 'phone') {
            tel_link = entryPoint.uri;
            tel = entryPoint.label;
            pin = entryPoint.pin;
            regionCode = entryPoint.regionCode;
        }
        if (type == 'more') {
            more_phones_link = entryPoint.uri;
        }
    }

    var confDetailsMessage = {
        "color": "#1F8456",
        "title": "Join Conference Call",
        "title_link": title_link,
        "text": title_link,
        "fields": [
            {
                "title": "Join by phone",
                "value": "<" + tel_link + ",," + pin + "%23" + "|" + tel + " PIN: " + pin + "#>",
                "short": false
            }
        ],
        "actions": [
            {
                "type": "button",
                "text": "Join Conference Call",
                "url": title_link,
                "style": "primary"
            }
        ],

        "footer": "Not in " + regionCode + "? More phone numbers at " + more_phones_link
    }

    var slackMessage = {
        username: 'Conference Call Details',
        icon_emoji: ':telephone_receiver:',
        channel: '',
        attachments: [],
        link_names: true,
        parse: 'none',
        mrkdwn: true,
    };
    slackMessage.attachments.push(confDetailsMessage);
    sendSlackMessageToChannel(incidentSlackChannelId, slackMessage, true);
}

function verifyPostRequest(method) {
    if (method !== 'POST') {
        const error = new Error('Only POST requests are accepted');
        error.code = 405;
        throw error;
    }
}

function verifySlackWebhook(body) {
    if (!body || body.token !== process.env.SLACK_COMMAND_TOKEN) {
        const error = new Error('Invalid credentials');
        error.code = 401;
        throw error;
    }
    if(!body.text){
        const error = new Error('Please provide a short description of your virtual coffee break. Usage: /coffee [short description]. Example: /coffee Coffee break to talk about music.');
        error.code = 422;
        throw error;
    }
}

async function createIncidentFlow(body) {
    var incidentId = moment().format('YYMMDDHHmm');
    var incidentName = body.text;
    var incidentCreatorSlackHandle = body.user_name;
    var incidentCreatorSlackUserId = body.user_id;

    var prefix = process.env.SLACK_INCIDENT_CHANNEL_PREFIX;
    if (!prefix) {
        prefix = 'incident-';
    }

    var incidentSlackChannel = prefix + incidentId;
    if (!incidentName) {
        incidentName = incidentSlackChannel;
    }

    var incidentSlackChannelID = await createSlackChannel(incidentName, incidentCreatorSlackUserId, incidentSlackChannel);

    alertIncidentManager(incidentName, incidentSlackChannelID, incidentCreatorSlackHandle);
    createAdditionalResources(incidentId, incidentName, incidentSlackChannelID, incidentSlackChannel, incidentCreatorSlackHandle);

    setTimeoutPromise(900000, incidentSlackChannelID).then((channelId) => {
        sendSlackMessageToChannel(channelId,{
                                                username: 'barista',
                                                icon_emoji: ':coffee:',
                                                text: "@here, We hope you had a good break :) I have to clean the table for the next guests and this channel will be archived. I hope to see you again soon in our cafe for another break!",
                                                link_names: true,
                                                parse: 'full'
                                            });

        console.log('archiving channel in 30 seconds.');
        setTimeoutPromise(30000, incidentSlackChannelID).then((channelId) => {
            archiveChannel(channelId);
        });
    });

    return incidentSlackChannelID;
}

async function createSlackChannel(incidentName, incidentCreatorSlackUserId, incidentSlackChannel) {
    try {
        const res = await rp.post({
            url: 'https://slack.com/api/channels.create',
            auth: {
                'bearer': process.env.SLACK_API_TOKEN
            },
            json: {
                name: '#' + incidentSlackChannel
            }
        });

        let channelId = res.channel.id;

        setChannelTopic(channelId, incidentName + '. Please join conference call to enjoy the break. See pinned message for details.');
        inviteUser(channelId, incidentCreatorSlackUserId);
        return res.channel.id
    } catch (error) {
        throw new Error(error);
    }
}

function createAdditionalResources(incidentId, incidentName, incidentSlackChannelId, incidentSlackChannel, incidentCreatorSlackHandle) {
    gapi_helper.registerIncidentEvent(incidentId,
        incidentName,
        incidentCreatorSlackHandle,
        incidentSlackChannel,
        function (eventDetails) {
            sendConferenceCallDetailsToChannel(incidentSlackChannelId, eventDetails);
        });

    var fileName = incidentSlackChannel;
    if(process.env.GDRIVE_INCIDENT_NOTES_FOLDER){
        gapi_helper.createIncidentsLogFile(fileName,
            process.env.GDRIVE_INCIDENT_NOTES_FOLDER,
            incidentName,
            incidentCreatorSlackHandle,
            function (url) {
                sendIncidentLogFileToChannel(incidentSlackChannelId, url);
            }
        );
    }

    createFollowupsEpic(incidentName, incidentSlackChannelId, incidentSlackChannel);

    // Return a formatted message
    var slackMessage = createInitialMessage(incidentName, incidentCreatorSlackHandle, incidentSlackChannel, incidentSlackChannelId);

    sendSlackMessageToChannel("#" + process.env.SLACK_INCIDENTS_CHANNEL, slackMessage);
    //remove join button from initial message and then send to incident channel
    slackMessage.attachments[0].actions.shift();
    sendSlackMessageToChannel(incidentSlackChannelId, slackMessage)
}

function setChannelTopic(channelId, topic) {
    request.post({
            url: 'https://slack.com/api/channels.setTopic',
            auth: {
                'bearer': process.env.SLACK_API_TOKEN
            },
            json: {
                'channel': channelId,
                'topic': topic
            }
        },
        function (error, response, body) {
            if (error || !body['ok']) {
                console.log('Error setting topic for channel ' + channelId);
            }
        });
}

function archiveChannel(channelId) {
    request.post({
            url: 'https://slack.com/api/channels.archive',
            auth: {
                'bearer': process.env.SLACK_API_TOKEN
            },
            json: {
                'channel': channelId
            }
        },
        function (error, response, body) {
            if (error || !body['ok']) {
                console.log('Error archiving channel ' + channelId + " - " + body['error']);
            }
        });
}

function createPostMortem(incidentName, epicKey, incidentSlackChannelId){

    if(!process.env.POST_MORTEMS_URL){
        return;
    }

    const now = new Date();

    request.post({
        url: process.env.POST_MORTEMS_URL + '/incident/create',
        json: {
            "key" : process.env.POST_MORTEMS_KEY,
            "incident" : {
                "name": incidentName,
                "when": date.format(now, 'YYYY-MM-DD HH:mm:ss'),
                "issueTracking" : "jira:"+epicKey,
                "channel" : "slack:"+incidentSlackChannelId
            }
        }
    },
    function (error, response, body) {
        if (error) {
            console.log(error);
        }
    });
}

function inviteUser(channelId, userId) {
    request.post({
            url: 'https://slack.com/api/channels.invite',
            auth: {
                'bearer': process.env.SLACK_API_TOKEN
            },
            json: {
                'channel': channelId,
                'user': userId
            }
        },
        function (error, response, body) {
            if (error || !body['ok']) {
                console.log('Error inviting user for channel');
                console.log(body, error);
            }
        });
}

function alertIncidentManager(incidentName, incidentSlackChannelID, incidentCreatorSlackHandle) {
    if (!process.env.PAGERDUTY_API_TOKEN || process.env.DRY_RUN) {
        console.log('pagerduty not setup');
        return
    }

    request.post({
        url: "https://events.pagerduty.com/v2/enqueue",
        json: {
            "routing_key": process.env.PAGERDUTY_API_TOKEN,
            "event_action": "trigger",
            "payload": {
                "summary": "New incident '" + incidentName + "' created by @" + incidentCreatorSlackHandle,
                "source": incidentSlackChannelID,
                "severity": "critical",
                "custom_details": {
                    "slack_deep_link_url": "https://slack.com/app_redirect?team=" + process.env.SLACK_TEAM_ID + "&channel=" + incidentSlackChannelID,
                    "slack_deep_link": "slack://channel?team=" + process.env.SLACK_TEAM_ID + "&id=" + incidentSlackChannelID
                }
            },
        }
    })
}

function sendSlackMessageToChannel(slackChannel, slackMessage, pin_message) {
    if (process.env.DRY_RUN) {
        console.log("Sending message below to channel " + slackChannel);
        console.log(slackMessage);
        return;
    }
    const newMessage = {
        ...slackMessage,
        channel: slackChannel
    };

    request.post({
            url: 'https://slack.com/api/chat.postMessage',
            auth: {
                'bearer': process.env.SLACK_API_TOKEN
            },
            json: newMessage
        },
        function (error, response, body) {
            if (error) {
                console.error('Sending message to Slack channel failed:', error);
                throw new Error('Sending message to Slack channel failed');
            }
            if (pin_message) {
                var ts = body['ts'];
                var channel = body['channel'];
                request.post({
                        url: 'https://slack.com/api/pins.add',
                        auth: {
                            'bearer': process.env.SLACK_API_TOKEN
                        },
                        json: {
                            'channel': channel,
                            'timestamp': ts
                        }
                    }, (error, response) => {
                        if (error) {
                            console.log('Error pinning message to channel: ' + error);
                        }
                    }
                );
            }
        });
}

function createFollowupsEpic(incidentName, incidentChannelId, incidentSlackChannel) {
    var jiraDomain = process.env.JIRA_DOMAIN;
    //Return if JIRA details are not specified. Assuming checking the domain is enough
    if (!jiraDomain) {
        return
    }

    var jiraUser = process.env.JIRA_USER;
    var jiraApiKey = process.env.JIRA_API_KEY;
    var jiraProjectId = process.env.JIRA_PROJECT_ID;
    var jiraEpicIssueTypeId = process.env.JIRA_ISSUE_TYPE_ID;

    const newMessage = {
        "fields": {
            "issuetype": {
                "id": jiraEpicIssueTypeId
            },
            "project": {
                "id": jiraProjectId
            },
            "summary": incidentName,
            "customfield_10009": incidentSlackChannel,
        }
    };

    request.post({
            url: 'https://' + jiraDomain + '/rest/api/3/issue',
            auth: {
                'user': jiraUser,
                'pass': jiraApiKey
            },
            json: newMessage
        },
        function (error, response, body) {
            if (error) {
                console.error('Sending message to Jira failed:', error);

                throw new Error('Sending message to Jira failed');
            }
            var epicKey = response.body['key'];
            var epicUrl = epicKey ? 'https://' + jiraDomain + '/browse/' + epicKey : '';
            sendEpicToChannel(incidentChannelId, epicUrl);
            createPostMortem(incidentName, epicKey, incidentChannelId)
        });
}

http.createServer(function (req, res) {
    try {
        verifyPostRequest(req.method);

        var body = '';
        var post = {};
        req.on('data', function (chunk) {
            body += chunk;
        });

        req.on('end', async function () {
            console.log('body: ' + body);
            post = qs.parse(body);

            verifySlackWebhook(post);

            var incidentChannelId = await createIncidentFlow(post);

            console.log('Successful execution of coffee flow');

            res.writeHead(200, {'Content-Type': 'application/json'});
            res.write(JSON.stringify({
                // text: "Incident management process started. Join incident channel: #"+incidentChannel,
                text: "Enjoy your coffee break :) Join coffee channel: slack://channel?team=" + process.env.SLACK_TEAM_ID + "&id=" + incidentChannelId,
                incident_channel_id: incidentChannelId
            }));
            res.end();
        });
    } catch (error) {
        console.log(error);

        res.writeHead((error.code ? error.code : 500), {'Content-Type': 'application/json'});
        res.write(JSON.stringify({response_type: "in_channel", text: error.message}));
        res.end();
    }
}).listen(process.env.PORT ? process.env.PORT : 8080);
console.log('Server listening on port ' + (process.env.PORT ? process.env.PORT : 8080));
