import querystring from 'querystring';
import fetch from 'node-fetch';
import HTMLParser from 'node-html-parser';
import CryptoJS from 'crypto-js';
import WebSocket from 'ws';

// Constants
const API_HOST = 'home.cielowigle.com';
const API_HTTP_PROTOCOL = 'https://';
const API_WS_PROTOCOL = 'wss://';
const PING_INTERVAL = 5 * 60 * 1000;
const DEFAULT_POWER = 'off';
const DEFAULT_MODE = 'auto';
const DEFAULT_FAN = 'auto';
const DEFAULT_TEMPERATURE = 75;

// Exports
class MrCoolAPIConnection {
    // Connection information
    #sessionID;
    #applicationCookies;
    #socketInfo;
    #userID;
    #accessToken;
    #agent;

    /**
     * WebSocket connection to API
     * 
     * @type WebSocket
     */
    #ws;

    /**
     * An array containing all subscribed HVACs
     * 
     * @type MrCoolHVAC[]
     */
    hvacs = [];

    // Callbacks
    #commandCallback;
    #temperatureCallback;
    #errorCallback;

    /**
     * Creates an API connection object that will use the provided callbacks
     * once created.
     * 
     * @param {function} commandCallback Callback that executes whenever a
     *      command is sent
     * @param {function} temperatureCallback Callback that executes whenever a
     *      temperature update is received
     * @param {function} errorCallback Callback that executes whenever an error
     *      is encountered 
     */
    constructor(commandCallback, temperatureCallback, errorCallback) {
        this.#commandCallback = commandCallback;
        this.#temperatureCallback = temperatureCallback;
        this.#errorCallback = errorCallback;
    }

    getSocketInfo() {
        return this.#socketInfo;
    }

    // Connection methods
    /**
     * Creates the hvacs array using the provided macAddresses and establishes
     * the WebSockets connection to the API to receive updates.
     * 
     * @param {string[]} macAddresses MAC addresses of desired HVACs
     * @returns {Promise<void>} A Promise containing nothing if resolved, error
     *      if an error occurs establishing the WebSocket connection
     */
    async subscribeToHVACs(macAddresses) {
        // Clear the array of any previously subscribed HVACs
        this.hvacs = [];

        // Get the initial information on all devices
        const deviceInfo = await this.#getDeviceInfo(
            await this.#getAccessCredentials());

        // Ensure the request was successful
        if (deviceInfo.error) return Promise.reject(deviceInfo.error);

        // Extract the relevant HVACs from the results
        for (const device of deviceInfo.data.listDevices) {
            if (macAddresses.includes(device.macAddress)) {
                let hvac = new MrCoolHVAC(device.macAddress, device.deviceName);
                hvac.applyUpdate(device.latestAction.power,
                    device.latestAction.temp, device.latestAction.mode,
                    device.latestAction.fanspeed, device.latEnv.temp);
                this.hvacs.push(hvac);
            }
        }

        // Establish the WebSocket connection
        return this.#connect();
    }

    /**
     * Obtains authentication and socket connection information from the API.
     * 
     * @param {string} username The username to login with 
     * @param {string} password The password for the provided username
     * @param {string} ip The public IP address of the network the HVACs are on
     * @param {string} agent Optional parameter specifying the agent type to
     *      identify as during the request
     * @returns {Promise<void>} A Promise containing nothing if resolved, and
     *      an error if one occurs during authentication
     */
    async establishConnection(username, password, ip, agent) {
        // TODO: Add ability to recognize authentication failure
        
        // Perform initial authentication
        this.#applicationCookies = await this.#getApplicationCookies(username,
            password, ip);
        const [appUser, sessionID] = await this.#getAppUserAndSessionId();

        // Save the results
        this.#sessionID = sessionID;
        this.#userID = appUser.userID;
        this.#accessToken = appUser.accessToken;
        this.#socketInfo = await this.#negotiateSocketInfo();

        return Promise.resolve();
    }
    
    /**
     * 
     * @returns 
     */
    #connect() {
        // Establish the WebSockets connection
        const connectUrl = new URL(API_WS_PROTOCOL + API_HOST
            + '/signalr/connect');
        connectUrl.search = querystring.stringify({
            'transport': 'webSockets',
            'clientProtocol': '2.1',
            'connectionToken': this.#socketInfo.ConnectionToken,
            'connectionData': JSON.stringify([{ 'name': 'devicesactionhub' }]),
            'tid': 0
        });
        const connectPayload = {
            'agent': this.#agent,
            'headers': {
                'Cookie': this.#applicationCookies
            }
        };
        this.#ws = new WebSocket(connectUrl, connectPayload);

        // const sendMode = function (mode, callback, errorCallback) {
        //     return ws.send(
        //         buildCommandPayload(connectionInfo.sessionId,
        //             connectionInfo.device.macAddress,
        //             connectionInfo.device.applianceID, state.commandCount++,
        //             'mode', mode, state.temp, state.power, state.fanspeed,
        //             state.mode),
        //         callback, errorCallback);
        // };

        this.#ws.on('open', () => {
            this.#startSocket();
        });

        this.#ws.on('close', () => {
            this.#errorCallback(new Error('Connection Closed.'));
        });

        this.#ws.on('message', (message) => {
            const data = JSON.parse(message);
            if (data.M && Array.isArray(data.M) && data.M.length && data.M[0].M
                && data.M[0].A && Array.isArray(data.M[0].A)
                && data.M[0].A.length) {
                const method = data.M[0].M;
                const status = data.M[0].A[0];
                switch (method) {
                    case 'actionReceivedAC':
                        this.hvacs.forEach((hvac, index) => {
                            if (hvac.getMacAddress() === status.macAddress) {
                                this.hvacs[index].applyUpdate(status.power,
                                    status.temp, status.mode, status.fanspeed,
                                    hvac.getRoomTemperature());
                            }
                        });
                        if (this.#commandCallback !== undefined) {
                            this.#commandCallback(status);
                        }
                        break;
                    case 'HeartBeatPerformed':
                        this.hvacs.forEach((hvac, index) => {
                            if (hvac.getMacAddress() === status.macAddress) {
                                this.hvacs[index].applyUpdate(hvac.getPower(),
                                    hvac.getTemperature(),
                                    hvac.getMode(), hvac.getFanSpeed(),
                                    status.roomTemperature);
                            }
                        });
                        if (this.#temperatureCallback !== undefined) {
                            this.#temperatureCallback(status.roomTemperature);
                        }
                        break;
                }
            }
        });

        this.#ws.on('error', (err) => {
            this.#errorCallback(err);
        });
    }

    // API Calls
    /**
     * Logs into the Cielo API using the provided credentials, and extracts the
     * relevant application cookies from the response.
     * 
     * @param {string} username The username to login with 
     * @param {string} password The password for the provided username
     * @param {string} ip The public IP address of the network the HVACs are on
     * @returns {Promise<string>} The relevant cookies from the login request
     */
    async #getApplicationCookies(username, password, ip) {
        const loginUrl = new URL(API_HTTP_PROTOCOL + API_HOST + '/auth/login');
        const loginPayload = {
            'agent': this.#agent,
            'headers': {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': ''
            },
            'body': 'mobileDeviceName=chrome&deviceTokenId=' + ip
                + '&timeZone=-07%3A00&state=&client_id=&response_type=&scope=&redirect_uri=&userId='
                + username + '&password=' + password + '&rememberMe=false',
            'method': 'POST',
            'redirect': 'manual'
        };
        const response = await fetch(loginUrl, loginPayload);
        return this.#getCookiesFromResponse(response);
    }

    /**
     * Extracts the appUser and sessionID values from the hidden HTML inputs on
     * the index page.
     * 
     * @returns {Promise<string[]>} An array containing the appUser and
     *      sessionID
     */
    async #getAppUserAndSessionId() {
        const appUserUrl = new URL(API_HTTP_PROTOCOL + API_HOST + '/home/index');
        const appUserPayload = {
            'agent': this.#agent,
            'headers': {
                'Cookie': this.#applicationCookies
            }
        };
        const appUserHtml = await fetch(appUserUrl, appUserPayload);
        const root = HTMLParser.parse(await appUserHtml.text());
        const appUserString = root.querySelector('#hdnAppUser')
            .getAttribute('value');
        const appUser = JSON.parse(this.#decryptString(appUserString));
        const sessionId = root.querySelector('#hdnSessionID')
            .getAttribute('value');
        return [appUser, sessionId];
    }

    /**
     * Obtains an access token for the API using cookies and a decrypted
     * username.
     * 
     * @returns {Promise<any>} A Promise containing the JSON response. Contains
     *      fields access_token, token_type, expires_in, userName, .issued, and
     *      .expires.
     */
    async #getAccessCredentials() {
        const tokenUrl = new URL(API_HTTP_PROTOCOL + API_HOST + '/cAcc');
        const tokenPayload = {
            'agent': this.#agent,
            'headers': {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': this.#applicationCookies
            },
            'body': 'grant_type=password&username=' + this.#userID
                + '&password=undefined',
            'method': 'POST'
        };
        const accessCredentials = await fetch(tokenUrl, tokenPayload);
        return accessCredentials.json();
    }

    /**
     * Performs the initial subscription to the API, providing current status of
     * all devices in the account.
     * 
     * @param {any} accessCredentials A JSON object containing valid credentials
     * @returns {Promise<any>} A Promise containing the JSON response
     */
    async #getDeviceInfo(accessCredentials) {
        const deviceInfoUrl = new URL(API_HTTP_PROTOCOL + API_HOST
            + '/api/device/initsubscription');
        const deviceInfoPayload = {
            'agent': this.#agent,
            'headers': {
                'Content-Type': 'application/json',
                'Authorization': accessCredentials.token_type + ' '
                    + accessCredentials.access_token
            },
            'body': JSON.stringify({
                'userID': this.#userID,
                'accessToken': this.#accessToken,
                'expiresIn': accessCredentials.expires_in,
                'sessionId': this.#sessionID
            }),
            'method': 'POST'
        };
        const deviceInfo = await fetch(deviceInfoUrl, deviceInfoPayload);
        return deviceInfo.json();
    }

    /**
     * Negotiates socket parameters with the Cielo API.
     * 
     * @returns {Promise<any>} A Promise containing the JSON response. Contains
     *      fields Url, ConnectionToken, ConnectionId, KeepAliveTimeout,
     *      DisconnectTimeout, ConnectionTimeout, TryWebSockets,
     *      ProtocolVersion, TransportConnectTimeout, and LongPollDelay.
     */
    async #negotiateSocketInfo() {
        const negotiateUrl = new URL(API_HTTP_PROTOCOL + API_HOST
            + '/signalr/negotiate');
        negotiateUrl.search = querystring.stringify({
            'connectionData': JSON.stringify([{ 'name': 'devicesactionhub' }]),
            'clientProtocol': '2.1',
            '_': '1588226985637'
        });
        const negotiatePayload = {
            'agent': this.#agent,
            'headers': {
                'Cookie': this.#applicationCookies
            }
        };
        const socketInfo = await fetch(negotiateUrl, negotiatePayload);
        return socketInfo.json();
    }

    /**
     * Starts the WebSocket connection and periodically pings it to keep it
     * alive
     * 
     * @returns {Promise<any>} A Promise containing nothing if resolved, and an
     *      error if rejected
     */
    async #startSocket() {
        const startUrl = new URL(API_HTTP_PROTOCOL + API_HOST
            + '/signalr/start');
        startUrl.search = querystring.stringify({
            'transport': 'webSockets',
            'connectionToken': this.#socketInfo.ConnectionToken,
            'connectionData': JSON.stringify([{ 'name': 'devicesactionhub' }]),
            'clientProtocol': '2.1',
            '_': '1588226985637'
        });
        const startPayload = {
            'agent': this.#agent,
            'headers': {
                'Cookie': this.#applicationCookies
            }
        };
        const startResponse = await fetch(startUrl, startPayload);

        // Periodically ping the socket to keep it alive
        const pingTimer = setInterval(async () => {
            try {
                await this.#pingSocket()
            } catch (error) {
                this.#errorCallback(error);
            }
        }, PING_INTERVAL);

        return Promise.resolve();
    }

    /**
     * 
     * @returns 
     */
    async #pingSocket() {
        const pingUrl = new URL(API_HTTP_PROTOCOL + API_HOST + '/signalr/ping');
        pingUrl.search = querystring.stringify({
            '_': '1588226985637'
        });
        const pingPayload = {
            'agent': this.#agent,
            'headers': {
                'Cookie': this.#applicationCookies
            }
        };
        const pingResponse = await fetch(pingUrl, pingPayload);
        return pingResponse.json();
    }

    // Utility methods
    /**
     * A function that extracts cookies that the responses requests the client
     * set.
     * 
     * @param {Response} response A response to an HTTP request
     * @returns A string containing all of the set cookies
     */
    #getCookiesFromResponse(response) {
        const cookieArray = response.headers.raw()['set-cookie'];
        return cookieArray.map((element) => element.split(';')[0]).join(';');
    }

    // From: https://stackoverflow.com/questions/36474899/encrypt-in-javascript-and-decrypt-in-c-sharp-with-aes-algorithm
    #decryptString(input) {
        const key = CryptoJS.enc.Utf8.parse('8080808080808080');
        const iv = CryptoJS.enc.Utf8.parse('8080808080808080');
        const output = CryptoJS.AES.decrypt(input, key, {
            'FeedbackSize': 128,
            'key': key,
            'iv': iv,
            'mode': CryptoJS.mode.CBC,
            'padding': CryptoJS.pad.Pkcs7
        });
        return output.toString(CryptoJS.enc.Utf8);
    };

    /**
     * 
     * @param {*} temp 
     * @param {*} power 
     * @param {*} fanspeed 
     * @param {*} mode 
     * @param {*} macAddress 
     * @param {*} applianceID 
     * @param {*} isAction 
     * @param {*} performedAction 
     * @param {*} performedValue 
     * @param {*} mid 
     * @param {*} deviceTypeVersion 
     * @param {*} fwVersion 
     * @returns 
     */
    #buildCommand(
        temp, power, fanspeed, mode, macAddress, applianceID,
        isAction,
        performedAction, performedValue, mid, deviceTypeVersion, fwVersion) {
        return {
            'turbo': null,
            'mid': isAction ? mid : '',
            'mode': (isAction && performedAction === 'mode') ? performedValue : mode,
            'modeValue': '',
            'temp': (isAction && performedAction === 'temp') ? performedValue : temp,
            'tempValue': '',
            'power': (isAction && performedAction === 'power') ? performedValue : power,
            'swing': (isAction && (performedAction === 'mode' || performedAction === 'temp' || (performedAction === 'power' && performedValue === 'off'))) ? 'Auto' : 'auto',
            'fanspeed': fanspeed,
            'scheduleID': '',
            'macAddress': macAddress,
            'applianceID': applianceID,
            'performedAction': isAction ? performedAction : '',
            'performedActionValue': isAction ? performedValue : '',
            'actualPower': power,
            'modeRule': '',
            'tempRule': isAction ? 'default' : '',
            'swingRule': isAction ? 'default' : '',
            'fanRule': isAction ? ((performedAction === 'power' && performedValue === 'on') ? 'vanish' : 'default') : '',
            'isSchedule': false,
            'aSrc': 'WEB',
            'ts': isAction ? Math.round(Date.now() / 1000) : '',
            'deviceTypeVersion': isAction ? deviceTypeVersion : '',
            'deviceType': 'BREEZ-I',
            'light': '',
            'rStatus': '',
            'fwVersion': isAction ? fwVersion : '',
        };
    }

    /**
     * 
     * @param {*} sessionId 
     * @param {*} macAddress 
     * @param {*} applianceID 
     * @param {*} commandCount 
     * @param {*} performedAction 
     * @param {*} performedActionValue 
     * @param {*} tempValue 
     * @param {*} power 
     * @param {*} fanspeed 
     * @param {*} mode 
     * @returns 
     */
    #buildCommandPayload(sessionId, macAddress, applianceID, commandCount, performedAction, performedActionValue, tempValue, power, fanspeed, mode) {
        const deviceTypeVersion = 'BI03';
        const fwVersion = '2.4.2,2.4.1';
        return JSON.stringify({
            'H': 'devicesactionhub',
            'M': 'broadcastActionAC',
            'A': [
                buildCommand(tempValue, power, fanspeed, mode, macAddress, applianceID, true, performedAction, performedActionValue, sessionId, deviceTypeVersion, fwVersion),
                buildCommand(tempValue, power, fanspeed, mode, macAddress, applianceID, false, performedAction, performedActionValue, sessionId, deviceTypeVersion, fwVersion)
            ],
            'I': commandCount
        });
    }
}

class MrCoolHVAC {
    #power = DEFAULT_POWER;
    #temp = DEFAULT_TEMPERATURE;
    #mode = DEFAULT_MODE;
    #fanSpeed = DEFAULT_FAN;
    #roomTemperature = DEFAULT_TEMPERATURE;
    #deviceName = "";
    #commandCount = 0;
    #macAddress;

    constructor(macAddress, deviceName) {
        this.#macAddress = macAddress;
        this.#deviceName = deviceName;
    }

    getPower() {
        return this.#power;
    }

    getMode() {
        return this.#mode;
    }

    getFanSpeed() {
        return this.#fanSpeed;
    }

    getTemperature() {
        return this.#temp;
    }

    getRoomTemperature() {
        return this.#roomTemperature;
    }

    getMacAddress() {
        return this.#macAddress;
    }

    toString() {
        return this.#deviceName + " " + this.#macAddress + ": " + [this.#power,
            this.#mode, this.#fanSpeed, this.#temp, this.#roomTemperature]
            .join(', ');
    }

    applyUpdate(power, temp, mode, fanSpeed, roomTemperature) {
        // TODO: Do some bounds checking
        this.#power = power;
        this.#temp = temp;
        this.#mode = mode;
        this.#fanSpeed = fanSpeed;
        this.#roomTemperature = roomTemperature;
    }

    setMode(mode, callback, errorCallback) {
        // TODO: Implement
    }

    setFanSpeed(fanspeed, callback, errorCallback) {
        // TODO: Implement
    }

    setTemperature(temp, callback, errorCallback) {
        // TODO: Implement
    }

    powerOn(callback, errorCallback) {
        // TODO: Implement
    }

    powerOff(callback, errorCallback) {
        // TODO: Implement
    }
}

export {MrCoolHVAC, MrCoolAPIConnection};
