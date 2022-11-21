const querystring = require('querystring');
const fetch = require('node-fetch');
const HTMLParser = require('node-html-parser');
const CryptoJS = require('crypto-js');
const WebSocket = require('ws');

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
    #commandCount = 0;

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
        this.#commandCount = 0;

        // Get the initial information on all devices
        const deviceInfo = await this.#getDeviceInfo(
            await this.#getAccessCredentials());

        // Ensure the request was successful
        if (deviceInfo.error) return Promise.reject(deviceInfo.error);

        // Extract the relevant HVACs from the results
        for (const device of deviceInfo.data.listDevices) {
            if (macAddresses.includes(device.macAddress)) {
                let hvac = new MrCoolHVAC(device.macAddress, device.deviceName,
                    device.applianceID, device.fwVersion);
                hvac.updateState(device.latestAction.power,
                    device.latestAction.temp, device.latestAction.mode,
                    device.latestAction.fanspeed);
                hvac.updateRoomTemperature(device.latEnv.temp);
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
    async #connect() {
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

        // Start the socket when opened
        this.#ws.on('open', () => {
            this.#startSocket();
        });

        // Provide notification to the error callback when the connection is
        // closed
        this.#ws.on('close', () => {
            this.#errorCallback(new Error('Connection Closed.'));
        });

        // Subscribe to status updates
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
                                this.hvacs[index].updateState(status.power,
                                    status.temp, status.mode, status.fanspeed);
                            }
                        });
                        if (this.#commandCallback !== undefined) {
                            this.#commandCallback(status);
                        }
                        break;
                    case 'HeartBeatPerformed':
                        this.hvacs.forEach((hvac, index) => {
                            if (hvac.getMacAddress() === status.macAddress) {
                                this.hvacs[index].updateRoomTemperature(
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

        // Provide notification to the error callback when an error occurs
        this.#ws.on('error', (err) => {
            this.#errorCallback(err);
        });

        // Return a promise to notify the user when the socket is open
        return new Promise((resolve) => {
            this.#ws.on('open', () => {
                resolve();
            });
        })
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
        const time = new Date();
        const negotiateUrl = new URL(API_HTTP_PROTOCOL + API_HOST
            + '/signalr/negotiate');
        negotiateUrl.search = querystring.stringify({
            'connectionData': JSON.stringify([{ 'name': 'devicesactionhub' }]),
            'clientProtocol': '2.1',
            '_': time.getTime().toString()
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
        const time = new Date();
        const startUrl = new URL(API_HTTP_PROTOCOL + API_HOST
            + '/signalr/start');
        startUrl.search = querystring.stringify({
            'transport': 'webSockets',
            'connectionToken': this.#socketInfo.ConnectionToken,
            'connectionData': JSON.stringify([{ 'name': 'devicesactionhub' }]),
            'clientProtocol': '2.1',
            '_': time.getTime().toString()
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
        const time = new Date();
        const pingUrl = new URL(API_HTTP_PROTOCOL + API_HOST + '/signalr/ping');
        pingUrl.search = querystring.stringify({
            '_': time.getTime().toString()
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
     * Creates an object containing all necessary fields for a command
     * 
     * @param {string} temp Temperature setting
     * @param {string} power Power state, on or off
     * @param {string} fanspeed Fan speed setting
     * @param {string} mode Mode setting, heat, cool, or auto
     * @param {string} macAddress Device MAC address
     * @param {number} applianceID Appliance ID
     * @param {boolean} isAction Whether or not the command is an action
     * @param {string} performedAction Value this command is modifying
     * @param {string} performedValue Updated value for command
     * @param {string} mid Session ID
     * @param {string} deviceTypeVersion Device type version
     * @param {string} fwVersion Firmware version
     * @returns {any}
     */
    #buildCommand(temp, power, fanspeed, mode, macAddress, applianceID,
        isAction, performedAction, performedValue, mid, deviceTypeVersion,
        fwVersion) {
        return {
            'schTS': '',
            'tempRange': '',
            'turbo': 'off',
            'mid': isAction ? mid : '',
            'mode': (isAction && performedAction === 'mode')
                ? performedValue : mode,
            'modeValue': '',
            'temp': (isAction && performedAction === 'temp')
                ? performedValue : temp,
            'tempValue': '',
            'power': (isAction && performedAction === 'power')
                ? performedValue : power,
            'swing': (isAction && (performedAction === 'mode'
                || performedAction === 'temp' || (performedAction === 'power' 
                && performedValue === 'off'))) ? 'auto' : 'auto',
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
            'fanRule': isAction ? ((performedAction === 'power'
                && performedValue === 'on') ? 'vanish' : 'default') : '',
            'isSchedule': false,
            'aSrc': 'WEB',
            'ts': isAction ? Math.round(Date.now() / 1000) : '',
            'deviceTypeVersion': isAction ? deviceTypeVersion : '',
            'deviceType': 'BREEZ-I',
            'light': '',
            'rStatus': '',
            'fwVersion': isAction ? fwVersion : '',
            'exe': '',
            'isRunning': false
        };
    }

    /**
     * Returns a JSON command payload to execute a parameter change
     * 
     * @param {MrCoolHVAC} hvac The HVAC to perform the action on
     * @param {string} performedAction The parameter to change
     * @param {string} performedActionValue The value to change it to
     * @returns {string}
     */
    #buildCommandPayload(hvac, performedAction, performedActionValue) {
        const deviceTypeVersion = 'BI03';
        const commandCount = this.#commandCount++;
        const result = JSON.stringify({
            'H': 'devicesactionhub',
            'M': 'broadcastActionAC',
            'A': [
                this.#buildCommand(hvac.getTemperature(), hvac.getPower(),
                    hvac.getFanSpeed(), hvac.getMode(), hvac.getMacAddress(),
                    hvac.getApplianceID(), true, performedAction,
                    performedActionValue, this.#sessionID, deviceTypeVersion,
                    hvac.getFwVersion()),
                this.#buildCommand(hvac.getTemperature(), hvac.getPower(),
                    hvac.getFanSpeed(), hvac.getMode(), hvac.getMacAddress(),
                    hvac.getApplianceID(), false, performedAction,
                    performedActionValue, this.#sessionID, deviceTypeVersion,
                    hvac.getFwVersion())
            ],
            'I': commandCount
        });
        return result;
    }

    /**
     * Sends a command to the HVAC
     * 
     * @param {MrCoolHVAC} hvac The HVAC to perform the action on
     * @param {string} performedAction The parameter to change
     * @param {string} performedActionValue The value to change it to
     * @returns {Promise<void>}
     */
    async sendCommand(hvac, performedAction, performedActionValue) {
        return new Promise((resolve, reject) => {
            this.#ws.send(this.#buildCommandPayload(hvac, performedAction,
                performedActionValue), (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
        });
    }
}

class MrCoolHVAC {
    #power = DEFAULT_POWER;
    #temperature = DEFAULT_TEMPERATURE;
    #mode = DEFAULT_MODE;
    #fanSpeed = DEFAULT_FAN;
    #roomTemperature = DEFAULT_TEMPERATURE;
    #deviceName = 'HVAC';
    #macAddress = '0000000000';
    #applianceID = 0;
    #fwVersion = '0.0.0';

    /**
     * Creates a new HVAC with the provided parameters
     * 
     * @param {string} macAddress HVAC's MAC address
     * @param {string} deviceName HVAC's name
     * @param {number} applianceID Internal appliance ID
     * @param {string} fwVersion Firmware version
     */
    constructor(macAddress, deviceName, applianceID, fwVersion) {
        this.#macAddress = macAddress;
        this.#deviceName = deviceName;
        this.#applianceID = applianceID;
        this.#fwVersion = fwVersion;
    }

    /**
     * Returns the current power state
     * 
     * @returns {string}
     */
    getPower() {
        return this.#power;
    }

    /**
     * Returns the current temperature setting
     * 
     * @returns {string}
     */
    getTemperature() {
        return this.#temperature;
    }

    /**
     * Returns the current mode setting
     * 
     * @returns {string}
     */
    getMode() {
        return this.#mode;
    }

    /**
     * Returns the current fan speed
     * 
     * @returns {string}
     */
    getFanSpeed() {
        return this.#fanSpeed;
    }

    /**
     * Returns the current room temperature
     * 
     * @returns {string}
     */
    getRoomTemperature() {
        return this.#roomTemperature;
    }

    /**
     * Returns the device's MAC address
     * 
     * @returns {string}
     */
    getMacAddress() {
        return this.#macAddress;
    }

    /**
     * Returns the appliance ID
     * 
     * @returns {number}
     */
    getApplianceID() {
        return this.#applianceID;
    }

    /**
     * Returns the device's firmware version
     * 
     * @returns {string}
     */
    getFwVersion() {
        return this.#fwVersion;
    }

    /**
     * Returns a string representation containing state data
     * 
     * @returns {string}
     */
    toString() {
        return this.#deviceName + " " + this.#macAddress + ": " + [this.#power,
            this.#mode, this.#fanSpeed, this.#temperature,
            this.#roomTemperature].join(', ');
    }

    /**
     * Updates the state of the HVAC using the provided parameters
     * 
     * @param {string} power Updated power state, on or off
     * @param {string} temperature Updated temperature setting
     * @param {string} mode Updated mode, heat, cool, or auto
     * @param {string} fanSpeed Updated fan speed
     */
    updateState(power, temperature, mode, fanSpeed) {
        // TODO: Do some bounds checking
        this.#power = power;
        this.#temperature = temperature;
        this.#mode = mode;
        this.#fanSpeed = fanSpeed;
    }

    /**
     * Updates the measured room temperature
     * 
     * @param {string} roomTemperature Updated room temperature
     */
    updateRoomTemperature(roomTemperature) {
        this.#roomTemperature = roomTemperature;
    }

    setMode(mode, api) {
        return api.sendCommand(this, 'mode', mode);
    }

    setFanSpeed(fanspeed, api) {
        return api.sendCommand(this, 'fanspeed', fanspeed);
    }

    setTemperature(temperature, api) {
        return api.sendCommand(this, 'temp', temperature);
    }

    /**
     * Powers on the HVAC
     * 
     * @param {MrCoolAPIConnection} api The API to use to execute the command
     * @return {Promise<void>}
     */
    powerOn(api) {
        return api.sendCommand(this, 'power', 'on');
    }

    /**
     * Powers off the HVAC
     * 
     * @param {MrCoolAPIConnection} api The API to use to execute the command
     * @return {Promise<void>}
     */
     powerOff(api) {
        return api.sendCommand(this, 'power', 'off');
    }
}

module.exports = {
    MrCoolHVAC: MrCoolHVAC,
    MrCoolAPIConnection: MrCoolAPIConnection
};
