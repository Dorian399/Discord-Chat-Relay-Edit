-- Not much to the server end. More stuff is involved in setting up the bot.

-- Config:
         
local BotIP = "localhost" -- The IP of the bot hosting the websocket server we use to communicate with Discord.  
local PortNumber = 8080   -- Which port the websocket is on   

-------------------------------
-- No more config after this --


-- Function to notify players when a discord message is received
util.AddNetworkString("discord_message_received")
function notify(...) -- Function copied from the Evolve admin mod and modified to suit this mod
    local arg = {...}
    local strArg = {} -- Used for logging to 

    net.Start("discord_message_received")
    net.WriteUInt(#arg, 16)
    for i, a in ipairs(arg) do 
        if isnumber(a) then 
            a = tostring(a)
        end 

        if isstring(a) then 
            net.WriteBit(false)
            net.WriteString(a)
            table.insert(strArg, a)
        elseif IsColor(a) then 
            net.WriteBit(true)
            net.WriteUInt(a.r, 8)
            net.WriteUInt(a.g, 8)
            net.WriteUInt(a.b, 8)
            net.WriteUInt(a.a, 8)
        end
    end
    net.Broadcast()
    MsgN("[Discord] " .. table.concat(strArg, " "))
end

-- Converting a hex string to a color 
function hexToCol(hex)
    local len = #hex
    if len > 0 and string.sub(hex, 1, 1) == "#" then
        hex = string.sub(hex, 2)
        len = len - 1
    end
    if len >= 6 then
        local r = "0x" .. string.sub(hex, 1, 2)
        local g = "0x" .. string.sub(hex, 3, 4)
        local b = "0x" .. string.sub(hex, 5, 6)
        if len == 6 then return Color(tonumber(r), tonumber(g), tonumber(b))
        elseif len == 8 then
            local a = "0x" .. string.sub(hex, 7, 8)
            return Color(tonumber(r), tonumber(g), tonumber(b), tonumber(a))
        end
    end
end


-- In case connection to the websocket server has been lost, we are going to resort to a queue to send any new message when reconnected.
local queue = {} 

local connectingPlayers = {}
local playerJoinTimestamps = {}

local websocket
function connectToWebsocket()
    if WS ~= nil then 
        websocket = WS.Client("ws://" .. BotIP, PortNumber)
        websocket:Connect()

        websocket:on("open", function()
            websocket.connected = true

            if #queue > 0 then 
                websocket:Send(util.TableToJSON(queue))
                queue = {}
            end

            MsgN("Connection established to websocket server.")
        end)

        websocket:on("message", function(data)
            local packet = util.JSONToTable(data)

            if packet.requestStatus then 
                local connecting = {}
                for id, data in pairs(connectingPlayers) do 
                    table.insert(connecting, data)
                end

                local spawnedPlayers = {}
                for i, ply in ipairs(player.GetAll()) do 
                    table.insert(spawnedPlayers, {ply:Nick(), ply:SteamID(), playerJoinTimestamps[ply:SteamID()] or 0})
                end

                local response = {}
                response.type = "status"
                response.map = game.GetMap()
                response.connectingPlayers = connecting
                response.players = spawnedPlayers

                websocket:Send(util.TableToJSON(response))
            else 
                notify(Color(88, 101, 242), "(Discord) ", hexToCol(packet.color), packet.author, Color(255, 255, 255), ": " .. packet.content)
            end
        end)

        websocket:on("close", function()
            MsgN("Websocket connection closed. Attempting to reconnect...")
            if websocket.connected then 
                connectToWebsocket()
            end
        end)
    end
end

hook.Add("PlayerSay", "nubs_discord_communicator", function(ply, message)
    if WS ~= nil then 
        local packet = {}
        packet.type = "message"
        packet.from = ply:Nick()
        packet.fromSteamID = ply:SteamID64()
        packet.content = message

        if websocket == nil or (websocket ~= nil and not websocket:IsActive()) then 
            connectToWebsocket()
            table.insert(queue, packet)
        elseif websocket ~= nil and websocket:IsActive() then 
            websocket:Send(util.TableToJSON(packet))
        end
    else 
        MsgN("Discord communication inactive - missing required mod Gmod Websockets.")
    end
end)

gameevent.Listen("player_connect")
hook.Add("player_connect", "discord_comms_join", function(ply)
    if WS ~= nil then 
        local packet = {}
        packet.type = "join/leave"
        packet.messagetype = 1 -- 1 = join, 2 = first spawn, 3 = leave
        packet.username = ply.name
        packet.usersteamid = ply.networkid

        if websocket == nil or (websocket ~= nil and not websocket:IsActive()) then 
            connectToWebsocket()
            table.insert(queue, packet)
        elseif websocket ~= nil and websocket:IsActive() then 
            websocket:Send(util.TableToJSON(packet))
        end

        connectingPlayers[ply.networkid] = {ply.name, ply.networkid, os.time()}
        playerJoinTimestamps[ply.networkid] = os.time()
    else 
        MsgN("Discord communication inactive - missing required mod Gmod Websockets.")
    end
end)

hook.Add("PlayerInitialSpawn", "discord_comms_spawn", function(ply)
    if WS ~= nil then 
        local packet = {}
        packet.type = "join/leave"
        packet.messagetype = 2 -- 1 = join, 2 = first spawn, 3 = leave
        packet.username = ply:Nick()
        packet.usersteamid = ply:SteamID()

        if websocket == nil or (websocket ~= nil and not websocket:IsActive()) then 
            connectToWebsocket()
            table.insert(queue, packet)
        elseif websocket ~= nil and websocket:IsActive() then 
            websocket:Send(util.TableToJSON(packet))
        end

        connectingPlayers[ply:SteamID()] = nil
    else 
        MsgN("Discord communication inactive - missing required mod Gmod Websockets.")
    end
end)

gameevent.Listen("player_disconnect")
hook.Add("player_disconnect", "nsz_comms_disconnect", function(ply)
    if WS ~= nil then 
        local packet = {}
        packet.type = "join/leave"
        packet.messagetype = 3 -- 1 = join, 2 = first spawn, 3 = leave
        packet.username = ply.name
        packet.usersteamid = ply.networkid
        packet.reason = ply.reason

        if websocket == nil or (websocket ~= nil and not websocket:IsActive()) then 
            connectToWebsocket()
            table.insert(queue, packet)
        elseif websocket ~= nil and websocket:IsActive() then 
            websocket:Send(util.TableToJSON(packet))
        end

        connectingPlayers[ply.networkid] = nil -- This is already done in PlayerInitialSpawn, however not if they disconnect before they spawn. This ensures they get removed from connecting.
    else 
        MsgN("Discord communication inactive - missing required mod Gmod Websockets.")
    end
end)

hook.Add("Initialize", "discord_comms_init", function()
    MsgN("Attempting to establish connection to websocket server...")
    connectToWebsocket()
end)