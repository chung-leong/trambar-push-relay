var _ = require('lodash');
var Promise = require('bluebird');
var FS = require('fs');
var Express = require('express');
var BodyParser = require('body-parser');
var DNSCache = require('dnscache');
var Request = require('request');
var Moment = require('moment');
var Crypto = Promise.promisifyAll(require('crypto'));
var AWS = require('aws-sdk');
var CORS = require('cors');
var Database = require('database');
var Schema = require('schema');
var HttpError = require('http-error');

DNSCache({ enable: true, ttl: 300, cachesize: 1000 });

var FIFTEEN_MINUTE_RATE_LIMIT = parseInt(process.env.RATE_LIMIT) || 50000;

var SSL_PRIVATE_KEY_PATH = process.env.SSL_PRIVATE_KEY_PATH;
var SSL_CERTIFICATE_PATH = process.env.SSL_CERTIFICATE_PATH;

var FCM_ARN = process.env.FCM_ARN;
var APNS_ARN = process.env.APNS_ARN;
var WNS_ARN = process.env.WNS_ARN;

var SNS = Promise.promisifyAll(new AWS.SNS({ apiVersion: '2010-03-31' }));
var server;

/**
 * Start up service
 *
 * @return {Promise}
 */
function start() {
    return Promise.try(() => {
        var app = Express();
        app.use(BodyParser.json());
        app.use(CORS({
            optionsSuccessStatus: 200,
            methods: [ 'POST' ],
        }));
        app.set('json spaces', 2);
        app.post('/register', handleRegistration);
        app.post('/dispatch', handleDispatch);
        server = app.listen(80);
        createSchema();
    });
}

/**
 * Shut down service
 *
 * @return {Promise}
 */
function stop() {
    return new Promise((resolve, reject) => {
        if (server) {
            server.close();
            server.on('close', () => {
                resolve();
            });
        } else {
            resolve();
        }
    });
};

/**
 * Create database schema
 *
 * @return {Promise}
 */
function createSchema() {
    return Promise.try(() => {
        var db = Database.get();
        return db.schemaExists(Schema.name).then((exists) => {
            if (!exists) {
                var sql = `CREATE SCHEMA ${Schema.name}`;
                return db.execute(sql).then(() => {
                    return db.execute(Schema.tables).then(() => {
                        console.log(`Created schema "${Schema.name}"`);
                    });
                });
            }
        });
    }).catch((err) => {
        // we can't connect while the database is being created
        if (err.code !== 'ECONNREFUSED') {
            console.error(err);
        }
        return Promise.delay(5000).then(() => {
            return createSchema();
        });
    });
}

/**
 * Send response to browser as JSON object
 *
 * @param  {Response} res
 * @param  {Object} result
 */
function sendResponse(res, result) {
    res.json(result);
}

/**
 * Send error to browser as JSON object
 *
 * @param  {Response} res
 * @param  {Object} err
 */
function sendError(res, err) {
    var statusCode = err.statusCode;
    var message = err.message;
    if (!statusCode) {
        // not an expected error
        console.error(err);
        statusCode = 500;
        if (process.env.NODE_ENV === 'production') {
            message = 'Internal server error';
        }
    }
    res.status(statusCode).json({ message });
}

/**
 * Handle registration request
 *
 * @param  {Request} req
 * @param  {Response} res
 *
 * @return {Promise}
 */
function handleRegistration(req, res) {
    return Promise.try(() => {
        var network = _.toLower(req.body.network);
        var registrationId = req.body.registration_id;
        var details = req.body.details || {};
        var address = req.body.address || null;
        if (!registrationId) {
            throw new HttpError(400);
        }
        if (!_.includes([ 'fcm', 'apns', 'wns' ], network)) {
            throw new HttpError(400);
        }
        return Crypto.randomBytesAsync(16).then((buffer) => {
            var token = buffer.toString('hex');
            return updateRegistration(network, registrationId, details, address, token).then((row) => {
                return {
                    token: row.current_token,
                    ctime: Moment(row.ctime).toISOString(),
                    atime: Moment(row.atime).toISOString(),
                    message_count: row.message_count,
                };
            });
        });
    }).then((results) => {
        sendResponse(res, results);
    }).catch((err) => {
        sendError(res, err);
    });
}

/**
 * Handle message dispatch request
 *
 * @param  {Request} req
 * @param  {Response} res
 *
 * @return {Promise}
 */
function handleDispatch(req, res) {
    return Promise.try(() => {
        var signature = req.body.signature;
        var address = req.body.address;
        var messages = req.body.messages;
        if (!signature || !address || !messages) {
            throw new HttpError(400);
        }
        return confirmSignature(address, signature).then(() => {
            return checkRateLimit(address, messages.length).then(() => {
                var recipientTokens = _.uniq(_.flatten(_.map(messages, 'tokens')));
                var validTokens = [];
                var deviceMessageCounts = {};
                var errors = [];
                return findListeningDevices(address, recipientTokens).each((device) => {
                    var deviceMessages = _.filter(messages, (message) => {
                        return _.includes(message.tokens, device.current_token);
                    });
                    validTokens.push(device.current_token);
                    return sendMessages(device, deviceMessages).then(() => {
                        deviceMessageCounts[device.id] = deviceMessages.length;
                    }).catch((err) => {
                        errors.push(err.message);
                    });
                }).then(() => {
                    return updateStatistics(address, deviceMessageCounts);
                }).then(() => {
                    var invalidTokens = _.difference(recipientTokens, validTokens);
                    return {
                        invalid_tokens: _.isEmpty(invalidTokens) ? undefined : invalidTokens,
                        errors: _.isEmpty(errors) ? undefined : _.uniq(errors),
                    };
                });
            });
        });
    }).then((results) => {
        sendResponse(res, results);
    }).catch((err) => {
        sendError(res, err);
    });
}

/**
 * Set current_address and current_token of device record
 *
 * @param  {String} network
 * @param  {String} registrationId
 * @param  {String} details
 * @param  {String} address
 * @param  {String} token
 *
 * @return {Promise<Object|undefined>}
 */
function updateRegistration(network, registrationId, details, address, token) {
    var db = Database.get();
    var sql = `
        UPDATE ${Schema.name}.device
        SET current_address = $1, current_token = $2, atime = NOW()
        WHERE network = $3 AND registration_id = $4
        RETURNING *;
    `;
    var params = [ address, token, network, registrationId ];
    return db.query(sql, params).then((rows) => {
        if (rows.length > 0) {
            return rows[0];
        }
        var sql = `
            INSERT INTO ${Schema.name}.device (
                network,
                registration_id,
                details,
                current_address,
                current_token
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (registration_id)
            DO UPDATE SET current_address = $4, current_token = $5, atime = NOW()
            RETURNING *;
        `;
        var params = [ network, registrationId, details, address, token ];
        return db.query(sql, params).then((rows) => {
            return rows[0];
        });
    });
}

/**
 * Find rows in device when current address and token match the ones given
 *
 * @param  {String} address
 * @param  {String} tokens
 *
 * @return {Promise<Array<Object>>}
 */
function findListeningDevices(address, tokens) {
    var db = Database.get();
    var sql = `
        SELECT * FROM ${Schema.name}.device
        WHERE current_address = $1 AND current_token = ANY($2)
    `;
    var params = [ address, tokens ];
    return db.query(sql, params);
}

/**
 * Increment message_count in site and device
 *
 * @param  {String} address
 * @param  {Object<Number>} messageCounts
 *
 * @return {Promise}
 */
function updateStatistics(address, messageCounts) {
    // messageCounts is keyed by device ids
    var totalMessageCount = _.sum(_.values(messageCounts));
    if (totalMessageCount === 0) {
        return Promise.resolve();
    }
    var db = Database.get();
    var sql = `
        UPDATE ${Schema.name}.site
        SET message_count = message_count + $1
        WHERE address = $2
    `;
    var params = [ totalMessageCount, address ];
    return db.execute(sql, params).then((result) => {
        if (result.rowCount === 0) {
            var sql = `
                INSERT INTO ${Schema.name}.site (
                    address,
                    message_count
                )
                VALUES ($1, $2)
                ON CONFLICT (address)
                DO UPDATE SET message_count = ${Schema.name}.site.message_count + $2
            `;
            var params = [ address, totalMessageCount ];
            return db.execute(sql, params);
        }
    }).then(() => {
        var counts = _.uniq(_.values(messageCounts));
        var idsByCount = _.invertBy(messageCounts);
        return Promise.each(counts, (count) => {
            var ids = _.map(idsByCount[count], (key) => {
                return parseInt(key);
            });
            var sql = `
                UPDATE ${Schema.name}.device
                SET message_count = message_count + $1
                WHERE id = ANY($2)
            `;
            var params = [ count, ids ];
            return db.execute(sql, params);
        });
    });
}

function confirmSignature(address, signature) {
    // TODO
    return Promise.resolve();
}

var messageCountsByDomain = {};
var previousPeriod = getTimeRoundedTo15Min();

/**
 * Reject with HTTP status code 429 if too many messages have been sent from
 * the given address already
 *
 * @param  {String} address
 * @param  {Number} additional
 *
 * @return {Promise}
 */
function checkRateLimit(address, additional) {
    var currentPeriod = getTimeRoundedTo15Min();
    if (previousPeriod !== currentPeriod) {
        messageCountsByDomain = {};
        currentPeriod = previousPeriod;
    }
    var currentCount = messageCountsByDomain[address] || 0;
    if (currentCount + additional < FIFTEEN_MINUTE_RATE_LIMIT) {
        messageCountsByDomain[address] = currentCount + additional;
        return Promise.resolve();
    } else {
        return Promise.reject(new HttpError(429));
    }
}

/**
 * Return the current time, rounded down by 15 min interval
 *
 * @return {String}
 */
function getTimeRoundedTo15Min() {
    var t = new Date;
    t.setMinutes(Math.floor(t.getMinutes() / 15) * 15);
    t.setSeconds(0);
    t.setMilliseconds(0);
    return t.toISOString();
}

/**
 * Send messages to a device
 *
 * @param  {Object} device
 * @param  {Array<Object>} messages
 *
 * @return {Promise<Array<String>>}
 */
function sendMessages(device, messages) {
    return Promise.each(messages, (message) => {
        return sendMessage(device, message);
    });
}

/**
 * Send message to a device
 *
 * @param  {Object} device
 * @param  {Object} message
 *
 * @return {Promise<String>}
 */
function sendMessage(device, message) {
    return createEndPoint(device).then((endPointARN) => {
        var platformMessage = message[device.network];
        if (!platformMessage) {
            throw new Error(`Missing payload for push network: ${device.network}`);
        }
        var protocol;
        switch (device.network) {
            case 'fcm':
                protocol = 'GCM';
                break;
            case 'apns':
                protocol = /SANDBOX/.test(APNS_ARN) ? 'APNS_SANDBOX' : 'APNS';
                break;
            case 'wns':
                protocol = 'WNS';
                break;
        }
        var snsMessageBody = {};
        if (typeof(platformMessage.body) === 'string') {
            snsMessageBody[protocol] = platformMessage.body;
        } else {
            snsMessageBody[protocol] = JSON.stringify(platformMessage.body);
        }
        var params = {
            Message: JSON.stringify(snsMessageBody),
            MessageAttributes: platformMessage.attributes,
            MessageStructure: 'json',
            TargetArn: device.endpoint_arn,
        };
        return SNS.publishAsync(params).then((data) => {
            return data.MessageId;
        });
    });
}

/**
 * Create an SNS endpoint for the device if it doesn't have one already
 *
 * @param  {Object} device
 *
 * @return {Promise<String>}
 */
function createEndPoint(device) {
    if (device.endpoint_arn) {
        return Promise.resolve(device.endpoint_arn);
    }
    var applicationARN;
    switch (device.network) {
        case 'fcm':
            applicationARN = FCM_ARN;
            break;
        case 'apns':
            applicationARN = APNS_ARN;
            break;
        case 'wns':
            applicationARN = WNS_ARN;
            break;
    };
    var params = {
        PlatformApplicationArn: applicationARN,
        Token: device.registration_id,
    };
    return SNS.createPlatformEndpointAsync(params).then((data) => {
        var endpointARN = data.EndpointArn;
        return updateDeviceEndpoint(device, endpointARN).then((device) => {
            return device.endpoint_arn;
        });
    });
}

/**
 * Update a device's SNS endpoint
 *
 * @param  {Object} device
 * @param  {endpointARN} endPointARN
 *
 * @return {Object}
 */
function updateDeviceEndpoint(device, endPointARN) {
    var db = Database.get();
    var sql = `
        UPDATE ${Schema.name}.device
        SET endpoint_arn = $1
        WHERE id = $2
        RETURNING *;
    `;
    var params = [ endPointARN, device.id ];
    return db.query(sql, params).then((rows) => {
        return rows[0];
    });
}

exports.start = start;
exports.stop = stop;

if (process.argv[1] === __filename) {
    start();
}

_.each(['SIGTERM', 'SIGUSR2'], (sig) => {
    process.on(sig, function() {
        stop().then(() => {
            process.exit(0);
        });
    });
});

process.on('uncaughtException', function(err) {
    console.error(err);
});
