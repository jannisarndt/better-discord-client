import { GATEWAY_URL, GATEWAY_VERSION, GatewayOpcode, GatewayCloseCode, DEFAULT_INTENTS, INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY, MAX_RECONNECT_JITTER, HEARTBEAT_TIMEOUT, IDENTIFY_RATE_LIMIT, MAX_IDENTIFIES_PER_WINDOW, } from './constants';
export class GatewayManager {
    ws = null;
    token;
    intents;
    // Connection state
    connected = false;
    sessionId = null;
    sequenceNumber = null;
    resumeGatewayUrl = null;
    // Heartbeat
    heartbeatInterval = null;
    heartbeatTimer = null;
    lastHeartbeatAck = true;
    heartbeatTimeoutTimer = null;
    // Reconnection
    reconnectAttempts = 0;
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    shouldResume = false;
    reconnectTimer = null;
    // Rate limiting
    identifyTimestamps = [];
    // Event handlers
    handlers = {
        message: [],
        messageUpdate: [],
        messageDelete: [],
        messageDeleteBulk: [],
        ready: [],
        error: [],
        disconnect: [],
    };
    constructor(token, intents = DEFAULT_INTENTS) {
        this.token = token;
        this.intents = intents;
    }
    // Event subscription methods
    onMessage(handler) {
        this.handlers.message.push(handler);
    }
    onMessageUpdate(handler) {
        this.handlers.messageUpdate.push(handler);
    }
    onMessageDelete(handler) {
        this.handlers.messageDelete.push(handler);
    }
    onMessageDeleteBulk(handler) {
        this.handlers.messageDeleteBulk.push(handler);
    }
    onReady(handler) {
        this.handlers.ready.push(handler);
    }
    onError(handler) {
        this.handlers.error.push(handler);
    }
    onDisconnect(handler) {
        this.handlers.disconnect.push(handler);
    }
    connectResolve = null;
    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.connectResolve = resolve;
                const gatewayUrl = this.shouldResume && this.resumeGatewayUrl
                    ? this.resumeGatewayUrl
                    : GATEWAY_URL;
                const url = `${gatewayUrl}/?v=${GATEWAY_VERSION}&encoding=json`;
                this.ws = new WebSocket(url);
                this.ws.onopen = () => {
                    this.connected = true;
                };
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
                this.ws.onclose = (event) => {
                    this.handleClose(event.code, event.reason);
                };
                this.ws.onerror = (error) => {
                    this.handleError(new Error(`WebSocket error: ${error}`));
                    reject(error);
                };
            }
            catch (error) {
                reject(error);
            }
        });
    }
    disconnect() {
        this.cleanup();
        if (this.ws) {
            this.ws.close(1000, 'Client requested disconnect');
            this.ws = null;
        }
    }
    handleMessage(data) {
        try {
            const payload = JSON.parse(data);
            if (payload.s !== undefined && payload.s !== null) {
                this.sequenceNumber = payload.s;
            }
            switch (payload.op) {
                case GatewayOpcode.DISPATCH:
                    this.handleDispatch(payload);
                    break;
                case GatewayOpcode.HELLO:
                    this.handleHello(payload.d);
                    break;
                case GatewayOpcode.HEARTBEAT_ACK:
                    this.handleHeartbeatAck();
                    break;
                case GatewayOpcode.RECONNECT:
                    this.handleReconnectRequest();
                    break;
                case GatewayOpcode.INVALID_SESSION:
                    this.handleInvalidSession(payload.d);
                    break;
                default:
                    break;
            }
        }
        catch (error) {
            this.handleError(error);
        }
    }
    handleDispatch(payload) {
        const { t: eventType, d: eventData } = payload;
        if (!eventType)
            return;
        switch (eventType) {
            case 'READY':
                this.handleReady(eventData);
                break;
            case 'RESUMED':
                this.handleResumed();
                break;
            case 'MESSAGE_CREATE':
                this.handlers.message.forEach(handler => {
                    try {
                        handler(eventData);
                    }
                    catch (error) {
                        this.handleError(error);
                    }
                });
                break;
            case 'MESSAGE_UPDATE':
                this.handlers.messageUpdate.forEach(handler => {
                    try {
                        handler(eventData);
                    }
                    catch (error) {
                        this.handleError(error);
                    }
                });
                break;
            case 'MESSAGE_DELETE':
                this.handlers.messageDelete.forEach(handler => {
                    try {
                        handler(eventData);
                    }
                    catch (error) {
                        this.handleError(error);
                    }
                });
                break;
            case 'MESSAGE_DELETE_BULK':
                this.handlers.messageDeleteBulk.forEach(handler => {
                    try {
                        handler(eventData);
                    }
                    catch (error) {
                        this.handleError(error);
                    }
                });
                break;
            default:
                break;
        }
    }
    handleReady(data) {
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.reconnectAttempts = 0;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.shouldResume = false;
        if (this.connectResolve) {
            this.connectResolve();
            this.connectResolve = null;
        }
        this.handlers.ready.forEach(handler => {
            try {
                handler(data);
            }
            catch (error) {
                this.handleError(error);
            }
        });
    }
    handleResumed() {
        this.reconnectAttempts = 0;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.shouldResume = false;
    }
    handleHello(data) {
        this.heartbeatInterval = data.heartbeat_interval;
        this.startHeartbeat();
        if (this.shouldResume && this.sessionId && this.sequenceNumber !== null) {
            this.sendResume();
        }
        else {
            this.sendIdentify();
        }
    }
    handleHeartbeatAck() {
        this.lastHeartbeatAck = true;
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
    }
    handleReconnectRequest() {
        this.shouldResume = true;
        this.cleanup();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.scheduleReconnect();
    }
    handleInvalidSession(resumable) {
        if (resumable) {
            this.shouldResume = true;
            this.scheduleReconnect();
        }
        else {
            this.sessionId = null;
            this.sequenceNumber = null;
            this.shouldResume = false;
            this.scheduleReconnect();
        }
    }
    handleClose(code, reason) {
        this.cleanup();
        this.connected = false;
        this.handlers.disconnect.forEach(handler => {
            try {
                handler(code, reason);
            }
            catch (error) {
                this.handleError(error);
            }
        });
        if (this.isReconnectable(code)) {
            this.shouldResume = this.canResume(code);
            this.scheduleReconnect();
        }
    }
    handleError(error) {
        this.handlers.error.forEach(handler => {
            try {
                handler(error);
            }
            catch {
            }
        });
    }
    startHeartbeat() {
        if (!this.heartbeatInterval)
            return;
        this.sendHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.lastHeartbeatAck) {
                this.handleError(new Error('Heartbeat timeout'));
                this.cleanup();
                if (this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
                this.shouldResume = true;
                this.scheduleReconnect();
                return;
            }
            this.sendHeartbeat();
        }, this.heartbeatInterval);
    }
    sendHeartbeat() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        this.lastHeartbeatAck = false;
        const payload = {
            op: GatewayOpcode.HEARTBEAT,
            d: this.sequenceNumber,
        };
        this.ws.send(JSON.stringify(payload));
        this.heartbeatTimeoutTimer = setTimeout(() => {
            if (!this.lastHeartbeatAck) {
                this.handleError(new Error('Heartbeat ACK timeout'));
            }
        }, HEARTBEAT_TIMEOUT);
    }
    sendIdentify() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const now = Date.now();
        this.identifyTimestamps = this.identifyTimestamps.filter(timestamp => now - timestamp < IDENTIFY_RATE_LIMIT);
        if (this.identifyTimestamps.length >= MAX_IDENTIFIES_PER_WINDOW) {
            const oldestTimestamp = this.identifyTimestamps[0];
            const delay = IDENTIFY_RATE_LIMIT - (now - oldestTimestamp);
            setTimeout(() => this.sendIdentify(), Math.max(delay, 1000));
            return;
        }
        this.identifyTimestamps.push(now);
        const identify = {
            token: this.token,
            properties: {
                os: "Mac OS X",
                browser: "Chrome",
                device: "",
                has_client_mods: false,
                browser_user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            },
            intents: this.intents,
        };
        const payload = {
            op: GatewayOpcode.IDENTIFY,
            d: identify,
        };
        this.ws.send(JSON.stringify(payload));
    }
    sendResume() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        if (!this.sessionId || this.sequenceNumber === null)
            return;
        const resume = {
            token: this.token,
            session_id: this.sessionId,
            seq: this.sequenceNumber,
        };
        const payload = {
            op: GatewayOpcode.RESUME,
            d: resume,
        };
        this.ws.send(JSON.stringify(payload));
    }
    isReconnectable(code) {
        if (code === GatewayCloseCode.AUTHENTICATION_FAILED)
            return false;
        if (code === GatewayCloseCode.INVALID_SHARD)
            return false;
        if (code === GatewayCloseCode.SHARDING_REQUIRED)
            return false;
        if (code === GatewayCloseCode.INVALID_API_VERSION)
            return false;
        if (code === GatewayCloseCode.INVALID_INTENTS)
            return false;
        if (code === GatewayCloseCode.DISALLOWED_INTENTS)
            return false;
        return true;
    }
    canResume(code) {
        // Can resume after these codes
        if (code === GatewayCloseCode.UNKNOWN_ERROR)
            return true;
        if (code === GatewayCloseCode.UNKNOWN_OPCODE)
            return true;
        if (code === GatewayCloseCode.DECODE_ERROR)
            return true;
        if (code === GatewayCloseCode.NOT_AUTHENTICATED)
            return true;
        if (code === GatewayCloseCode.ALREADY_AUTHENTICATED)
            return true;
        if (code === GatewayCloseCode.INVALID_SEQ)
            return true;
        if (code === GatewayCloseCode.RATE_LIMITED)
            return true;
        if (code === GatewayCloseCode.SESSION_TIMED_OUT)
            return true;
        // Normal close codes
        if (code === 1000)
            return true;
        if (code === 1001)
            return true;
        if (code === 1006)
            return true;
        return false;
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        const jitter = 1 + (Math.random() * 2 - 1) * MAX_RECONNECT_JITTER;
        const delay = this.reconnectDelay * jitter;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectAttempts++;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
            this.connect().catch(error => {
                this.handleError(error);
                this.scheduleReconnect();
            });
        }, delay);
    }
    cleanup() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
        this.lastHeartbeatAck = true;
    }
    isConnected() {
        return this.connected && this.ws?.readyState === WebSocket.OPEN;
    }
    getSessionId() {
        return this.sessionId;
    }
    getSequenceNumber() {
        return this.sequenceNumber;
    }
}
