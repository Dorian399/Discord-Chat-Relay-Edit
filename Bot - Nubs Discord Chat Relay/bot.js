// This simple bot will allow discord messages to appear in your Garry's Mod server,
// as well as the server chat to appear in a Discord channel.

// You may notice I only require the functions I actually use. That's because Discord has made it so you have to specify
// exactly what you need/are doing with your bot. So I said fuck it and I might as well do that with everything :^) 

// We need this to read and write the config file, and the connection log
const { readFileSync, writeFile, appendFile, writeFileSync, existsSync, unlink } = require('fs');

// Allows for the gmod server and the bot to communicate
// At the time of writing this, I'm running ws version 8.5.0
const { WebSocketServer } = require('ws');

// Making a bot (duh)
// At the time of making this, I'm running discord.js version 14.11.0
const { Client, GatewayIntentBits, User, GuildMember } = require('discord.js'); 

// We use http.get to get Steam avatars. If you don't want avatars, you can comment this out and not install axios from npm.
// At the time of making this, I'm running axios version 1.4.0
const { get } = require('axios');

const Rcon = require("rcon");

let config = require("./config.js");
let webhookData = JSON.parse(readFileSync("./ids.json"));

function parseStatusData(input) {
    const lines = input.trim().split('\n');
    let hostname = '';
	let ip = '';
    let map = '';
    let numPlayers = 0;
    let activePlayers = [];
    let spawningPlayers = [];

    lines.forEach(line => {
        if (line.startsWith('hostname:')) {
            hostname = line.split('hostname:')[1].trim();
		} else if (line.startsWith('udp/ip')) {
            ip = line.split('udp/ip')[1].split(':')[1].split(' ')[1] + ":" + line.split('udp/ip')[1].split(':')[2].trim().split('(')[0].split(' ')[0];
        } else if (line.startsWith('map')) {
            map = line.split(':')[1].trim().split(' ')[0];
        } else if (line.startsWith('players')) {
            const match = line.match(/\d+/);
            if (match) {
                numPlayers = parseInt(match[0], 10);
            }
        } else if (line.startsWith('#') && !line.startsWith('# userid')) {
            const playerInfo = line.trim().split(/\s+/);
			
			
            
            let name = playerInfo.slice(2, playerInfo.length - 5)[0].replace(/[^a-zA-Z0-9_-]/g, '');
			if(name == "")
				name = "InvalidUsername";
            const steamID = playerInfo.slice(2, playerInfo.length - 5)[1];
            const timeConnected = playerInfo[playerInfo.length - 5];
            const status = playerInfo[playerInfo.length - 2];
            const playerData = [name, steamID, timeConnected, status];

            if (status === 'active') {
                activePlayers.push(playerData);
            } else if (status === 'spawning') {
                spawningPlayers.push(playerData);
            }
        }
    });

    return {
        hostname,
		ip,
        map,
        numPlayers,
        activePlayers,
        spawningPlayers
    };
}



function sendCommand(command, id) {
    return new Promise((resolve, reject) => {
        const rcon = new Rcon(config.ServerRcons[id].ip, config.ServerRcons[id].port, config.ServerRcons[id].password);

        let fullResponse = '';

        rcon.on('auth', () => {
            rcon.send(command);
        });

        rcon.on('response', (response) => {
            fullResponse += response;
			setTimeout(() => {
				rcon.disconnect();
			}, 500);
        });

        rcon.on('end', () => {
            if (fullResponse) {
                resolve(fullResponse); 
            } else {
                console.log('No response received from server');
            }
        });

        rcon.on('error', (err) => {
            console.log(err);
        });

        rcon.connect();
    });
}

// Constants
const wss = new WebSocketServer({host: '0.0.0.0', port: config.PortNumber}); // We set the host to '0.0.0.0' to tell the server we want to run IPv4 instead of IPv6
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildWebhooks, 
        GatewayIntentBits.MessageContent
    ],
	restRequestTimeout: 15000
});

if (config.DiscordUsernameFix) {
    // This is not a recommended thing to do, but since discord.js doesn't 
    // appear to be supporting the new username system any time soon, here's my own crude fix.
    // This will allow user global names to appear, as well as GuildMember.displayName showing it

    User.prototype.__Relay_InjectPatch = User.prototype._patch;
    User.prototype._patch = function (data) {
        this.__Relay_InjectPatch(data);

        if ('global_name' in data) {
            this.globalName = data.global_name;
        } else {
            this.globalName ??= null;
        }
    }
    Object.defineProperty(User.prototype, "displayName", {
        get: function displayName() {return this.globalName ?? this.username;}
    });

    Object.defineProperty(GuildMember.prototype, "displayName", {
        get: function displayName() {return this.nickname ?? this.user.displayName;}
    });
}


// logConnection - Called when someone attempts to connect to the websocket server. Logs it to ./connection_log.txt
function logConnection(ip, status) {
    let date = new Date();
    let timestamp = `[${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} @ ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}]`;

    let message = `\n${timestamp} ${status ? 'Accepting' : 'Denying'} websocket connection request from ${ip}`;

    console.log(message);

    if (config.LogConnections) 
        appendFile('./connection_log.txt', message, err => {if (err) console.err(err);});
}

// assignWebhook takes a webhook object and stores it for later
function assignWebhook(wh, id) {
	
    if (typeof webhook === 'undefined') {
        webhook = {}; // Ensure that webhook is initialized.
    }
    webhook[id] = wh; 
	
	if (!webhookData.Webhook) {
        webhookData.Webhook = {};
    }

    // Initialize webhookData.Webhook[id] if it does not exist
    if (!webhookData.Webhook[id]) {
        webhookData.Webhook[id] = {};
    }

    // Assign ID and Token from the `wh` object
    webhookData.Webhook[id].ID = wh.id;
    webhookData.Webhook[id].Token = wh.token;
	
	
}


function saveIds() {
    writeFile("./ids.json", JSON.stringify(webhookData, null, 4), err => {if (err) console.error(err);});
}

// getSteamAvatar checks the avatar cache and refreshes them when needed.
let avatarCache = {};
async function getSteamAvatar(id) {
    if (config.SteamAPIKey.length === 0  || id == 0) // If there is no API key specified, they must not want avatars.
        return;

    let needsRefresh = false;
    if (avatarCache[id]) {
        if (Date.now() - avatarCache[id].lastFetched >= config.SteamAvatarRefreshTime * 60000) {
            needsRefresh = true;
        }
    } else {
        needsRefresh = true;
    }

    if (needsRefresh) {
        let res = await get(`http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${config.SteamAPIKey}&steamids=${id}`);
        avatarCache[id] = {
            avatar: res.data.response.players[0].avatarfull,
            lastFetched: Date.now()
        };
    }
}

// I use a queueing system to stack up messages to be sent through the webhook. I wait for the previous webhook to send just in case they try to send out of order.
let queue = [];
let runningQueue = false;
let replyInteraction;
let statusTimeout = [];
let updateTimeout = null;
let updateInterval = null;

async function sendQueue(ws) {
    if (!webhook || runningQueue)
        return; 

    runningQueue = true;

    for (let i = 0; i < queue.length; i++) {
        let packet = queue[i];
        switch (packet.type) {
            case "message": {
                if (packet.content.length > 0) {
                    let opts = {
                        content: packet.content,
                        username: packet.from
                    }
                    
					if(packet.fromSteamID != 0){
						await getSteamAvatar(packet.fromSteamID);
						if (avatarCache[packet.fromSteamID]) 
							opts.avatarURL = avatarCache[packet.fromSteamID].avatar;
					};
                    
					
                    await webhook[packet.id].send(opts);
                }
            } break;

            case "join/leave": {
				
				UpdateStatusChannel()
				UpdateCompactStatusChannel();
				
				if (!config.HideJoinLeaveNotifs){
				
					let options = {
						username: "Player Connection Status"
					}
					// 1 = join, 2 = spawn, 3 = leave
					switch (packet.messagetype) {
						case 1: {
							options.content = `${packet.username} (${packet.usersteamid}) has connected to the server.`;
						} break;

						case 2: {
							let spawnText = '';

							if (packet.userjointime) {
								let spawnTime = Math.round(Date.now()/1000) - packet.userjointime;
								let minutes = Math.floor(spawnTime / 60);
								let seconds = spawnTime % 60;
								spawnText = ` (took ${minutes}:${seconds < 10 ? `0${seconds}` : seconds})`;
							}

							options.content = `${packet.username} (${packet.usersteamid}) has spawned into the server${spawnText}.`
						} break;

						case 3: {
							options.content = `${packet.username} (${packet.usersteamid}) has left the server (${packet.reason}).`
						} break;
					}

					await webhook[packet.id].send(options);
				};
            } break;

            case "status": {
				if (!replyInteraction) return;
				if (statusTimeout) {
					clearTimeout(statusTimeout[ws.id]);
				}

				const format = packet.format; // Get the format from the packet

				let rows = [];
				const now = Math.round(Date.now() / 1000);

				// Function to format the time
				function formatTime(timeOnServer) {
					let hours = Math.floor(timeOnServer / 60 / 60);
					let minutes = Math.floor(timeOnServer / 60) % 60;
					let seconds = timeOnServer % 60;
					return `${hours}:${minutes < 10 ? `0${minutes}` : minutes}:${seconds < 10 ? `0${seconds}` : seconds}`;
				}

				// Process connecting players
				for (let i = 0; i < packet.connectingPlayers.length; i++) {
					let data = packet.connectingPlayers[i];
					let timeString = data[2] ? formatTime(now - data[2]) : 'Unknown';
					let currentStatus = "Connecting";
					rows.push([data[0], data[1], timeString, currentStatus]);
				}

				// Process active players
				for (let i = 0; i < packet.players.length; i++) {
					let data = packet.players[i];
					if (data.name == undefined) data.name = "[no name received?]";
					if (data.steamid == undefined) data.steamid = "[no steamid received?]";

					let timeString = data.jointime ? formatTime(Math.round(data.jointime)) : 'Unknown';
					let currentStatus = "Active";
					if (data.afktime) {
						let timeAFK = now - data.afktime;
						currentStatus = `AFK for ${formatTime(timeAFK)}`;
					}
					rows.push([data.name, data.steamid, timeString, currentStatus]);
				}

				const numplayers = packet.players.length + packet.connectingPlayers.length;

				if (format === "ext") {
					// Extended format (original code)
					let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

					let maxNameLength = name.length;
					let maxSteamidLength = steamid.length;
					let maxJoinTimestamp = joined.length;
					let maxStatus = status.length;

					// Calculate max lengths
					for (let row of rows) {
						maxNameLength = Math.max(maxNameLength, row[0].length);
						maxSteamidLength = Math.max(maxSteamidLength, row[1].length);
						maxJoinTimestamp = Math.max(maxJoinTimestamp, row[2].length);
						maxStatus = Math.max(maxStatus, row[3].length);
					}

					let linesOfText = [
						`| ${name.padEnd(maxNameLength)} | ${steamid.padEnd(maxSteamidLength)} | ${joined.padEnd(maxJoinTimestamp)} | ${status.padEnd(maxStatus)} |`,
						`|${'-'.repeat(maxNameLength + 2)}|${'-'.repeat(maxSteamidLength + 2)}|${'-'.repeat(maxJoinTimestamp + 2)}|${'-'.repeat(maxStatus + 2)}|`
					];

					for (let row of rows) {
						linesOfText.push(`| ${row[0].padEnd(maxNameLength)} | ${row[1].padEnd(maxSteamidLength)} | ${row[2].padEnd(maxJoinTimestamp)} | ${row[3].padEnd(maxStatus)} |`);
					}

					let serverText = `**${packet.hostname}**\n[${packet.ip}](https://vauff.com/connect.php?ip=${packet.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${packet.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
					
					if (statuscount < relaySockets.length) {
						statustext = statustext ? statustext + '\n\n' + serverText : serverText;
						statuscount++;
					} else {
						if (replyInteraction.id != webhookData.StatusChannelMessageID && replyInteraction.id != webhookData.CompactStatusChannelMessageID)
							replyInteraction.editReply((statustext ? statustext + '\n\n' : '') + serverText).then(() => replyInteraction = undefined);
						else
							replyInteraction.edit((statustext ? statustext + '\n\n' : '') + serverText).then(() => replyInteraction = undefined);

							
					}
				} else if (format === "simple") {
					
					let maxNameLength = 0;

					// Calculate max lengths
					for (let row of rows) {
						maxNameLength = Math.max(maxNameLength, row[0].length);
					}
					
				
					let linesOfText;
					let servertext;
					
					if(numplayers>0){ 
						linesOfText = rows.map(row => `${row[0].padEnd(maxNameLength)} | ${row[2]} | ${row[3]}`) 
						serverText =  `**${packet.hostname}**\n[${packet.ip}](https://vauff.com/connect.php?ip=${packet.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${packet.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
					}else{
						serverText =  `**${packet.hostname}**\n[${packet.ip}](https://vauff.com/connect.php?ip=${packet.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${packet.map}**`;
					};
					

					if (statuscount < relaySockets.length) {
						statustext = statustext ? statustext + '\n\n' + serverText : serverText;
						statuscount++;
					} else {
						if (replyInteraction.id != webhookData.StatusChannelMessageID && replyInteraction.id != webhookData.CompactStatusChannelMessageID)
							replyInteraction.editReply((statustext ? statustext + '\n\n' : '') + serverText).then(() => replyInteraction = undefined);
						else
							replyInteraction.edit((statustext ? statustext + '\n\n' : '') + serverText).then(() => replyInteraction = undefined);
					}
				}
			} break;



			
			case "init": {
				if (packet.id.length > 0) {
					for(socket in relaySockets){
						if(relaySockets[socket].id == packet.id)
							delete relaySockets[socket];
					};
					ws.id = packet.id
					
					if(!config.HideWebsocketNotifs){
						if (webhook && webhook[packet.id]) {
							webhook[packet.id].send({
								username: "Websocket Status",
								content: "Connection to server established."
							});
						}
					};
				};
				
				if (updateTimeout !== null)
					clearTimeout(updateTimeout);
				
				if (updateInterval !== null)
					clearInterval(updateInterval);
				
				
				updateTimeout = setTimeout( () => { UpdateStatusChannel(); UpdateCompactStatusChannel(); }, 1000);
				updateInterval = setInterval(() => {
					UpdateStatusChannel();
					UpdateCompactStatusChannel();
				}, 1000*config.StatusRefreshTime);
			} break;
        }
    }

    // Made it to the end of the queue, clear it
    queue = [];
    runningQueue = false;
}

// getWebhook creates a webhook object if it can't find one that was stored.



async function getWebhook(json) {
    if (!client.isReady()) 
        return;

    if (!webhookData["channels"]) {
        return console.log("Tried to create a webhook, but no channel has been set yet.");
    }

    for (const data in webhookData["channels"]) {
        try {
            const wh = await client.fetchWebhook(webhookData.Webhook[data].ID, webhookData.Webhook[data].Token);
            assignWebhook(wh, data);

            if (json === true) {
                let webhookOptions = {
                    username: "Websocket Status",
                    content: "Bot started. "
                };

                if (existsSync('./error.txt')) {
                    webhookOptions.content += `Bot has just restarted from a crash:\`\`\`\n${readFileSync('./error.txt')}\`\`\``;
                    unlink('./error.txt', error => {
                        if (error) {
                            console.log("Unable to delete error.txt. Previous crash report will reprint on next restart unless you manually delete the file");
                            console.error(error);
                        }
                    });
                }

                webhookOptions.content += "Awaiting server connection...";
				if(!config.HideBotStartMessage){
					await wh.send(webhookOptions);
				};
            }
        } catch (error) {
            
            if (webhookData.channels[data].ChannelID == 0) {
                console.log("Tried to create a webhook, but no channel has been set yet.");
                continue;
            }


            let channel = client.channels.resolve(webhookData["channels"][data].ChannelID);
            if (channel) {
                try {
                    const wh = await channel.createWebhook({
                        name: "Dickord Communication Relay"
                    });
                    assignWebhook(wh, data);
                    saveIds();
                } catch (creationError) {
                    console.error(`Failed to create webhook for id: ${data}`, creationError);
                }
            }
        }
    }

    if (webhook && json) {
        if (Array.isArray(json)) { // When the gmod server loses connection to the websocket, it stores them in an array and sends them all when connection is reestablished
            for (let i = 0; i < json.length; i++) {
                queue.push(json[i]);
            }
            sendQueue();
        } else if (json instanceof Object) {
            queue.push(json);
            sendQueue();
        }
    }
}


// Websocket server stuff
let webhook;
let relaySockets = []; // Array to hold multiple WebSocket connections

wss.shouldHandle = req => {
    let ip = req.socket.remoteAddress;
    if (ip === "127.0.0.1") 
        ip = "localhost";

    let accepting = ip === config.ServerIP;

    logConnection(ip, accepting);
    
    return accepting;
};

wss.on('connection', async ws => {
    relaySockets.push(ws); // Add new connection to the array



    ws.on('message', buf => {
        let json;
        try {
            json = JSON.parse(buf.toString());
        } catch(err) {
            console.log("Invalid JSON received from server.");
        }

        if (!webhook) {
            getWebhook(json);
        } else {
            if (json instanceof Array) { // From a queue of messages from a lost connection
                for (let i = 0; i < json.length; i++) {
                    queue.push(json[i]);
                }
                sendQueue(ws);
            } else if (json instanceof Object) {
                queue.push(json);
                sendQueue(ws);
            }
        }
    });

    ws.on('error', error => {
        console.log("Error occurred in relay socket");
        console.error(error);

        if (webhook) {
            webhook[ws.id].send({
                username: "Error Reporting",
                content: `Error occurred in the relay socket:\`\`\`\n${error.stack}\`\`\``
            });
        }
    });

    ws.on('close', () => {
        console.log("Connection to server closed.");

		if(!config.HideWebsocketNotifs){
			if (webhook) {
				webhook[ws.id].send({
					username: "Websocket Status",
					content: "Connection to server closed. Awaiting reconnect..."
				});
			}
		};
		
		// Remove the closed socket from the array
        relaySockets = relaySockets.filter(socket => socket !== ws);
    });
});

wss.on('error', async err => {
    console.log('Error occurred in websocket server:');
    console.error(err);

    if (webhook) {
        await webhook[wss.id].send({
            username: "Error Reporting",
            content: `Error occurred in websocket server:\`\`\`\n${err.stack}\`\`\`Restarting...`
        });
    }
    process.exit();
});

wss.on('close', async () => {
    console.log("Websocket server closed. What the..");
    if (webhook) {
        await webhook[wss.id].send({
            username: "Error Reporting",
            content: "Websocket server closed for an unknown reason. Restarting..."
        });
    }
    process.exit();
});

// Functions for eval (js)

// Hides certain config values to prevent exposing private keys
function sanitizePrivateValues(str) {
	let newString = str.replaceAll(config.DiscordBotToken, "[Hidden]");
	for(id in webhookData.Webhook){
		if (config.SteamAPIKey.length > 0) 
			newString = newString.replaceAll(config.SteamAPIKey, "[Hidden]");
		if (webhookData.Webhook[id].Token.length > 0) 
			newString = newString.replaceAll(webhookData.Webhook[id].Token, "[Hidden]");
		if (config.ServerRcons[id].password.length > 0)
			newString = newString.replaceAll(config.ServerRcons[id].password, "[Hidden]");
	};
    
    return newString;
}

// This is hacky, you probably should not do this. This temporarily overwrites console.log in the eval dev command to allow logging output at stages
let normalConsoleLog = console.log;
let temporaryLogs = [];
function log() {
    temporaryLogs.push(sanitizePrivateValues(Array.from(arguments).join(" ")));
}
function overwriteConsoleLog() {
    temporaryLogs = [];
    console.log = log;
}
function revertConsoleLog() {
    console.log = normalConsoleLog;
}

// Discord stuff
client.on('messageCreate', async message => {
    if (message.author.bot)
        return; // Do nothing for bots

    let ranCommand = false;
    if (config.Managers.includes(message.author.id) && message.content.trimStart().startsWith(config.ManagerCommandPrefix)) {
        let inputText = message.content.trimStart().slice(config.ManagerCommandPrefix.length);
        let command = inputText.split(' ', 1)[0].toLowerCase();
        inputText = inputText.slice(command.length).trim();

        ranCommand = true;
        switch (command) {
            case "setgmodchannel": {
				let arg = inputText.split(' ', 1)[0];
				if(!webhookData["channels"]) webhookData["channels"] = {};
				if(!webhookData["channels"][arg]) webhookData["channels"][arg] = {};
				if(!webhookData.Webhook) webhookData.Webhook = {};
				if(!webhookData.Webhook[arg]) webhookData.Webhook[arg] = {};
                webhookData["channels"][arg].ChannelID = message.channel.id;
				webhookData.Webhook[arg].ID = message.channel.id;
				webhookData.ChannelID = "set";
                saveIds();
                message.react('✅');
            } break;
			
			case "setstatuschannel": {
				webhookData.StatusChannelID = message.channel.id;
                message.react('✅');
				setTimeout(() => {
					message.channel.send('Status channel set.').then(messagee => {
						webhookData.StatusChannelMessageID = messagee.id;
						saveIds();
						setTimeout(() => { UpdateStatusChannel() },2000);
					});
					if(message.length > 0)
						message.delete();
				}, 2000);
            } break;
			
			case "setstatusmchannel": {
				webhookData.CompactStatusChannelID = message.channel.id;
                message.react('✅');
				setTimeout(() => {
					message.channel.send('Status channel set.').then(messagee => {
						webhookData.CompactStatusChannelMessageID = messagee.id;
						saveIds();
						setTimeout(() => { UpdateCompactStatusChannel() },2000);
					});
					if(message.length > 0)
						message.delete();
				}, 2000);
            } break;

            case "restart":
            case "shutdown": {
                message.react('✅').then(() => process.exit()).catch(() => process.exit());
            } break;

            case "console":
            case "cmd":
            case "concommand":
            case "c":
            case "command": {
                // Send command to all relay sockets
                relaySockets.forEach(socket => {
					if(!webhookData["channels"] || !webhookData["channels"][socket.id]) return;
					if (message.channel.id != webhookData["channels"][socket.id].ChannelID) return;
					if(config.UseRconForCommands && config.ServerRcons[socket.id].password.length > 0){
						sendCommand(inputText,socket.id)
						.then(response => {
							message.reply("Command executed successfully.\n```"+response+"```")
							return;
						})
						.catch(err => {
							if (socket.readyState === 1) {
								let packet = {
									type: "concommand",
									from: message.member.displayName,
									command: inputText
								};
								socket.send(Buffer.from(JSON.stringify(packet)));
								message.react('✅');
							}
							return;
						});
					};
					
					if (socket.readyState === 1) {
						let packet = {
							type: "concommand",
							from: message.member.displayName,
							command: inputText
						};
						socket.send(Buffer.from(JSON.stringify(packet)));
					}
					message.react('✅');
                });
            } break;

            case "eval":
            case "evaluate":
            case "js_run": {
				if (!config.EvalEnable) return;
                inputText = inputText.replace(/```(js)?/g, '');
                if (inputText.length === 0) 
                    return message.reply('Invalid input. Please provide JavaScript code to run.');
                
                try {
                    overwriteConsoleLog();
                    let result = eval(inputText);
                    revertConsoleLog();

                    let newMessageObject = {files: []};

                    if (temporaryLogs.length > 0) {
                        newMessageObject.files.push({attachment: Buffer.from(temporaryLogs.join('\n')), name: "console.txt"});
                    }

                    if (result === undefined || result === null) newMessageObject.content = "Evaluated successfully.";
                    else if (result instanceof Object || result instanceof Array) result = JSON.stringify(result, null, 2);
                    else if (typeof result !== "string") result = result !== undefined ? result.toString() : "";

                    if (!newMessageObject.content) {
                        if (result.length > 256) {
                            newMessageObject.content = `Evaluated without error.`;
                            newMessageObject.files.push({attachment: Buffer.from(sanitizePrivateValues(result)), name: "result.txt"});
                        } else {
                            newMessageObject.content = `Evaluated without error.\`\`\`\n${sanitizePrivateValues(result)}\`\`\``;
                        }
                    }

                    message.reply(newMessageObject);
                } catch (error) {
                    let newMessageObject = {
                        content: `An error occurred while evaluating that code.\`\`\`\n${sanitizePrivateValues(error.stack)}\`\`\``
                    };
					if(!config.ShowEvalErrors){
						newMessageObject = {
							content: `An error occurred while evaluating that code.\`\`\`\n${sanitizePrivateValues(error.stack)}\`\`\``
						};
					};
                    if (temporaryLogs.length > 0) {
                        newMessageObject.files = [{attachment: Buffer.from(temporaryLogs.join('\n')), name: "console.txt"}];
                    }
                    message.reply(newMessageObject);
                }
            } break;

            default: {
                ranCommand = false;
            } break;
        }        
    } 

    if (ranCommand) return;
	
	let iscurchannel_included = false;
	
	for(whdata in webhookData["channels"]){
		if (message.channel.id == webhookData["channels"][whdata]["ChannelID"]) iscurchannel_included = true;
		if ( message.system || message.content.trimStart().startsWith(config.ManagerCommandPrefix) ) return;
	};
	
	if (!iscurchannel_included) return;
	
	if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) return message.react('⚠️');

	if (message.cleanContent.length > config.MaxMessageLength) return message.react('❌');

	let lines = message.content.split('\n');
	if (lines.length > config.LineBreakLimit) return message.react('❌');
	
	let packet = {
		type: "message",
		color: message.member.displayHexColor,
		author: message.member.displayName,
		content: message.cleanContent || "[attachment]",
		time: Math.floor(Date.now() / 1000)
	};

	if (message.reference) {
		try {
			let reference = await message.fetchReference();
			if (reference.member) {
				packet.replyingTo = {
					author: reference.member.displayName,
					color: reference.member.displayHexColor
				}
			} else if (reference.author) {
				if (reference.author.id === client.user.id || reference.author.id === webhookData.Webhook.ID) {
					packet.replyingTo = {author: reference.author.username}
				} else {
					try {
						let member = await message.guild.members.fetch(reference.author.id);
						if (member) {
							packet.replyingTo = {
								author: member.displayName,
								color: member.displayHexColor
							}
						} else {
							packet.replyingTo = {author: reference.author.username}
						}
					} catch (_) {
						packet.replyingTo = {author: reference.author.username}
					}
				}
			}
		} finally {}
	}
	
	let mid;
	for(data in webhookData["channels"]){
		if(webhookData["channels"][data].ChannelID == message.channel.id){
			mid=data;
			break;
		}
	}
	
	
	relaySockets.forEach(socket => {
		if(socket.id==mid){
			if (socket.readyState === 1) {
				socket.send(Buffer.from(JSON.stringify(packet)));
			}
		};
    });
});

var statustext = ""
var statuscount = 1



function GetServersStatus(interaction){
    if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
        return interaction.reply('There is currently no connection to the server. Unable to request status.\nThe server automatically reconnects when an event happens, such as a player joining/leaving, or sending a message on the server.');

    interaction.reply('Requesting server status...').then(() => {
        if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
            return interaction.editReply('Websocket is not connected.');

        replyInteraction = interaction;
        let packet = {
            type: "status",
            from: interaction.member.displayName,
            color: interaction.member.displayHexColor,
			time: Math.floor(Date.now() / 1000),
			format: "ext"
        };
		
		statustext = ""
	    statuscount = 1
		
		
        relaySockets.forEach(socket => {
            if (socket.readyState === 1) {
                socket.send(Buffer.from(JSON.stringify(packet)));
            }
			
			statusTimeout[socket.id] = setTimeout(() => {

				sendCommand('status',socket.id)
					.then(response => {
						
						
						const statustable = parseStatusData(response);
						
						let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

						let maxNameLength    = name.length;
						let maxSteamidLength = steamid.length;
						let maxJoinTimestamp = joined.length;
						let maxStatus        = status.length;

						let rows = [];

						let now = Math.round(Date.now() / 1000);
						for (let i = 0; i < statustable.spawningPlayers.length; i++) {
							let data = statustable.spawningPlayers[i];

							let timeString = data[2];

							let currentStatus = "Connecting";
							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);

							rows.push([data[0], data[1], timeString, currentStatus]);
						}

						for (let i = 0; i < statustable.activePlayers.length; i++) {
							let data = statustable.activePlayers[i];

							if (data.name == undefined) data.name = "[no name received?]";
							if (data.steamid == undefined) data.steamid = "[no steamid received?]";

							let timeString = data[2];

							let currentStatus = "Active";

							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);

							rows.push([data[0], data[1], timeString, currentStatus]);
						}

						let linesOfText = [
							`| ${name + ' '.repeat(maxNameLength - name.length)} | ${steamid + ' '.repeat(maxSteamidLength - steamid.length)} | ${joined + ' '.repeat(maxJoinTimestamp - joined.length)} | ${status + ' '.repeat(maxStatus - status.length)} |`,
							`|${'-'.repeat(maxNameLength + 2)}|${'-'.repeat(maxSteamidLength + 2)}|${'-'.repeat(maxJoinTimestamp + 2)}|${'-'.repeat(maxStatus + 2)}|`
						];

						for (let i = 0; i < rows.length; i++) {
							let row = rows[i];
							linesOfText.push(`| ${row[0].padEnd(maxNameLength)} | ${row[1] + ' '.repeat(maxSteamidLength - row[1].length)} | ${row[2] + ' '.repeat(maxJoinTimestamp - row[2].length)} | ${row[3] + ' '.repeat(maxStatus - row[3].length)} |`);
						}

						const numplayers = statustable.numPlayers;

						let serverText = `**${statustable.hostname}**\n[${statustable.ip}](https://vauff.com/connect.php?ip=${statustable.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
						
									
						if(statustext == ""){
							replyInteraction?.editReply(serverText);
							statustext = serverText;
							statuscount++;
						}else{
							replyInteraction?.editReply(statustext + '\n\n' + serverText);
						};
					})
					.catch(err => {
						if(statustext == ""){
							replyInteraction?.editReply("**" +socket.id + "**" + " Server is empty or unreachable.");
							statustext = "**" +socket.id + "**" + " Server is empty or unreachable.";
							statuscount++;
						}else{
							replyInteraction?.editReply(statustext + "\n\n" + "**" +socket.id + "**" + " Server is empty or unreachable.");
						};
					});
				clearTimeout(statusTimeout[socket.id])
			}, 700);
			
        });
	    
    });
}


function GetCompactServersStatus(interaction){
	
	if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
        return interaction.reply('There is currently no connection to the server. Unable to request status.\nThe server automatically reconnects when an event happens, such as a player joining/leaving, or sending a message on the server.');

    interaction.reply('Requesting server status...').then(() => {
        if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
            return interaction.editReply('Websocket is not connected.');

        replyInteraction = interaction;
        let packet = {
            type: "status",
            from: interaction.member.displayName,
            color: interaction.member.displayHexColor,
			time: Math.floor(Date.now() / 1000),
			format: "simple"
        };
		
		statustext = ""
	    statuscount = 1
		
		
        relaySockets.forEach(socket => {
			
			
            if (socket.readyState === 1) {
                socket.send(Buffer.from(JSON.stringify(packet)));
            }
			
			statusTimeout[socket.id] = setTimeout(() => {

				sendCommand('status',socket.id)
					.then(response => {
						
						
						const statustable = parseStatusData(response);
						
						let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

						let maxNameLength    = name.length;
						let maxSteamidLength = steamid.length;
						let maxJoinTimestamp = joined.length;
						let maxStatus        = status.length;

						let rows = [];

						let now = Math.round(Date.now() / 1000);
						for (let i = 0; i < statustable.spawningPlayers.length; i++) {
							let data = statustable.spawningPlayers[i];

							let timeString = data[2];

							let currentStatus = "Connecting";
							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);
							
							rows.push([data[0], data[1], timeString, currentStatus]);
						}

						for (let i = 0; i < statustable.activePlayers.length; i++) {
							let data = statustable.activePlayers[i];

							if (data.name == undefined) data.name = "[no name received?]";
							if (data.steamid == undefined) data.steamid = "[no steamid received?]";

							let timeString = data[2];

							let currentStatus = "Active";

							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);

							rows.push([data[0], data[1], timeString, currentStatus]);
						}


						const numplayers = statustable.numPlayers;
						
						let linesOfText;
						let servertext;
						
						for (let i = 0 ; i < rows.length; i++ ){
							if (rows[i][0].length < maxNameLength)
								rows[i][0] = rows[i][0] + " ";
							else
								break;
						};
						
						if(numplayers>0){ 
							linesOfText = rows.map(row => `${row[0].padEnd(maxNameLength)} | ${row[2]} | ${row[3]}`) 
							serverText =  `**${statustable.hostname}**\n[${statustable.ip}](https://vauff.com/connect.php?ip=${statustable.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
						}else{
							serverText =  `**${statustable.hostname}**\n[${statustable.ip}](https://vauff.com/connect.php?ip=${statustable.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**`;
						};



						if(statustext == ""){
							replyInteraction?.editReply(serverText);
							statustext = serverText;
							statuscount++;
						}else{
							replyInteraction?.editReply(statustext + '\n\n' + serverText);
						};
					})
					.catch(err => {
						if(statustext == ""){
							replyInteraction?.editReply("**" +socket.id + "**" + " Server is empty or unreachable.");
							statustext = "**" +socket.id + "**" + " Server is empty or unreachable.";
							statuscount++;
						}else{
							replyInteraction?.editReply(statustext + "\n\n" + "**" +socket.id + "**" + " Server is empty or unreachable.");
						};
					});
				clearTimeout(statusTimeout[socket.id])
			}, 700);
			
        });
	    
    });
}

async function UpdateStatusChannel(){
	if (!webhookData.StatusChannelID || webhookData.StatusChannelID.length == 0 || !webhookData.StatusChannelMessageID || webhookData.StatusChannelMessageID.length == 0)
		return;
	try {
		let statuschannel = await client.channels.fetch(webhookData.StatusChannelID);
		let statusmessage = await statuschannel.messages.fetch(webhookData.StatusChannelMessageID);
		let interaction = statusmessage;
		
		if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
			return interaction.edit('There is currently no connection to the server. Unable to request status.\nThe server automatically reconnects when an event happens, such as a player joining/leaving, or sending a message on the server.');

		if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
			return interaction.editReply('Websocket is not connected.');

		replyInteraction = statusmessage;
		
		let packet = {
			type: "status",
			from: interaction.member.displayName,
			color: interaction.member.displayHexColor,
			time: Math.floor(Date.now() / 1000),
			format: "ext"
		};
		
		statustext = ""
		statuscount = 1
		
		
		relaySockets.forEach(async socket => {
			
			await new Promise(r => setTimeout(r, 60));
			
			for(s in relaySockets){
				if(relaySockets[s].id == undefined)
					delete relaySockets[s];
			};
			
			if (socket.readyState === 1) {
				socket.send(Buffer.from(JSON.stringify(packet)));
			}
			
			statusTimeout[socket.id] = setTimeout(() => {

				sendCommand('status',socket.id)
					.then(response => {
						
						
						const statustable = parseStatusData(response);
						
						let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

						let maxNameLength    = name.length;
						let maxSteamidLength = steamid.length;
						let maxJoinTimestamp = joined.length;
						let maxStatus        = status.length;

						let rows = [];

						let now = Math.round(Date.now() / 1000);
						for (let i = 0; i < statustable.spawningPlayers.length; i++) {
							let data = statustable.spawningPlayers[i];

							let timeString = data.timeConnected;

							let currentStatus = "Connecting";
							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);

							rows.push([data[0], data[1], timeString, currentStatus]);
						}

						for (let i = 0; i < statustable.activePlayers.length; i++) {
							let data = statustable.activePlayers[i];

							if (data.name == undefined) data.name = "[no name received?]";
							if (data.steamid == undefined) data.steamid = "[no steamid received?]";

							let timeString = statustable.activePlayers.timeConnected;

							let currentStatus = "Active";

							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);

							rows.push([data[0], data[1], timeString, currentStatus]);
						}

						let linesOfText = [
							`| ${name + ' '.repeat(maxNameLength - name.length)} | ${steamid + ' '.repeat(maxSteamidLength - steamid.length)} | ${joined + ' '.repeat(maxJoinTimestamp - joined.length)} | ${status + ' '.repeat(maxStatus - status.length)} |`,
							`|${'-'.repeat(maxNameLength + 2)}|${'-'.repeat(maxSteamidLength + 2)}|${'-'.repeat(maxJoinTimestamp + 2)}|${'-'.repeat(maxStatus + 2)}|`
						];

						for (let i = 0; i < rows.length; i++) {
							let row = rows[i];
							linesOfText.push(`| ${row[0].padEnd(maxNameLength)} | ${row[1] + ' '.repeat(maxSteamidLength - row[1].length)} | ${row[2] + ' '.repeat(maxJoinTimestamp - row[2].length)} | ${row[3] + ' '.repeat(maxStatus - row[3].length)} |`);
						}

						const numplayers = statustable.numPlayers;

						let serverText = `**${statustable.hostname}**\n[${statustable.ip}](https://vauff.com/connect.php?ip=${statustable.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
						
									
						if(statustext == ""){
							replyInteraction?.edit(serverText);
							statustext = serverText;
							statuscount++;
						}else{
							replyInteraction?.edit(statustext + '\n\n' + serverText);
						};
					})
					.catch(err => {
						return;
					});
				clearTimeout(statusTimeout[socket.id])
			}, 700);
		});
	} catch (error) {
        console.error('Error updating status:', error);
    }
}

async function UpdateCompactStatusChannel(){
	if (!webhookData.CompactStatusChannelID || webhookData.CompactStatusChannelID.length == 0 || !webhookData.CompactStatusChannelMessageID || webhookData.CompactStatusChannelMessageID.length == 0)
		return;
	try {
		let statuschannel = await client.channels.fetch(webhookData.CompactStatusChannelID);
		let statusmessage = await statuschannel.messages.fetch(webhookData.CompactStatusChannelMessageID);
		let interaction = statusmessage;
		
		if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
			return interaction.edit('There is currently no connection to the server. Unable to request status.\nThe server automatically reconnects when an event happens, such as a player joining/leaving, or sending a message on the server.');

		if (relaySockets.length === 0 || !relaySockets.some(socket => socket.readyState === 1)) 
			return interaction.editReply('Websocket is not connected.');

		replyInteraction = statusmessage;
		
		let packet = {
			type: "status",
			from: interaction.member.displayName,
			color: interaction.member.displayHexColor,
			time: Math.floor(Date.now() / 1000),
			format: "simple"
		};
		
		statustext = ""
		statuscount = 1
		
		
		relaySockets.forEach(async socket => {
			
			await new Promise(r => setTimeout(r, 60));
			
			for(s in relaySockets){
				if(relaySockets[s].id == undefined)
					delete relaySockets[s];
			};
			
			if (socket.readyState === 1) {
				socket.send(Buffer.from(JSON.stringify(packet)));
			}
			
			statusTimeout[socket.id] = setTimeout(() => {

				sendCommand('status',socket.id)
					.then(response => {
						
						
						const statustable = parseStatusData(response);
						
						let [name, steamid, joined, status] = ['Name', 'Steam ID', 'Time Connected', "Status"];

						let maxNameLength    = name.length;
						let maxSteamidLength = steamid.length;
						let maxJoinTimestamp = joined.length;
						let maxStatus        = status.length;

						let rows = [];

						let now = Math.round(Date.now() / 1000);
						for (let i = 0; i < statustable.spawningPlayers.length; i++) {
							let data = statustable.spawningPlayers[i];

							let timeString = data[2];

							let currentStatus = "Connecting";
							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);
							
							rows.push([data[0], data[1], timeString, currentStatus]);
						}

						for (let i = 0; i < statustable.activePlayers.length; i++) {
							let data = data[2];

							if (data.name == undefined) data.name = "[no name received?]";
							if (data.steamid == undefined) data.steamid = "[no steamid received?]";

							let timeString = statustable.activePlayers.timeConnected;

							let currentStatus = "Active";

							maxNameLength    = Math.max(maxNameLength, data[0].length);
							maxSteamidLength = Math.max(maxSteamidLength, data[1].length);
							maxJoinTimestamp = Math.max(maxJoinTimestamp, timeString.length);
							maxStatus        = Math.max(maxStatus, currentStatus.length);

							rows.push([data[0], data[1], timeString, currentStatus]);
						}


						const numplayers = statustable.numPlayers;
						
						let linesOfText;
						let servertext;
					
						
						if(numplayers>0){ 
							linesOfText = rows.map(row => `${row[0].padEnd(maxNameLength)} | ${row[2]} | ${row[3]}`) 
							serverText =  `**${statustable.hostname}**\n[${statustable.ip}](https://vauff.com/connect.php?ip=${statustable.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**\`\`\`\n${linesOfText.join('\n')}\`\`\``;
						}else{
							serverText =  `**${statustable.hostname}**\n[${statustable.ip}](https://vauff.com/connect.php?ip=${statustable.ip})\n**${numplayers}** ${numplayers == 1 ? 'person is' : 'people are'} playing on map **${statustable.map}**`;
						};



						if(statustext == ""){
							replyInteraction?.edit(serverText);
							statustext = serverText;
							statuscount++;
						}else{
							replyInteraction?.edit(statustext + '\n\n' + serverText);
						};
					})
					.catch(err => {
						return;
					});
				clearTimeout(statusTimeout[socket.id])
			}, 700);
		});
	} catch (error) {
        console.error('Error updating status:', error);
    }
}


if (!config.DisableInteractions){
	client.on('interactionCreate', interaction => {
		if(!interaction.isCommand()) return;
		if (interaction.commandName === "status") {
			GetServersStatus(interaction);
		}else if(interaction.commandName === "statusm") {
		   GetCompactServersStatus(interaction);
		}
		
	});
};

client.on('ready', () => {
    console.log("Bot initialized");

    getWebhook(true);
	if (!config.DisableInteractions){
		client.application.commands.set([
			{
				name: "status",
				description: "View how many players are on the server along with the map."
			},
			{
				name: "statusm",
				description: "View how many players are on the server along with the map in a more compact way."
			},
		]);
	};
	if(config.ServerRcons){
		setTimeout(() => {
			for(let id in config.ServerRcons){
				sendCommand("reconnectwebsocket",id)
			};
		}, 15000);
	};
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error(reason);
	process.exit();
});

process.on('uncaughtException', (error, origin) => {
    if (origin !== "uncaughtException") return;
    
    console.error(error);
    writeFileSync('./error.txt', error.stack);
    process.exit();
});

client.login(config.DiscordBotToken);
