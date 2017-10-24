var _ = require('lodash');
var Promise = require('bluebird');
var FS = require('fs');
var HTTPS = require('https');
var Express = require('express');
var BodyParser = require('body-parser');
var DNSCache = require('dnscache');
var Request = require('request');
var Moment = require('moment');
var Database = require('database');
var Schema = require('schema');
var HttpError = require('http-error');
var AWS = require('aws-sdk');

DNSCache({ enable: true, ttl: 300, cachesize: 1000 });

var FIFTEEN_MINUTE_RATE_LIMIT = parseInt(process.env.RATE_LIMIT) || 50000;

var SSL_PRIVATE_KEY_PATH = process.env.SSL_PRIVATE_KEY_PATH;
var SSL_CERTIFICATE_PATH = process.env.SSL_CERTIFICATE_PATH;

var GCM_ARN = process.env.GCM_ARN;
var APNS_ARN = process.env.APNS_ARN;
var WNS_ARN = process.env.WNS_ARN;

var SNS = Promise.promisifyAll(new AWS.SNS({ apiVersion: '2010-03-31' }));
var server;

function start() {
    var app = Express();
    app.use(BodyParser.json());
    app.set('json spaces', 2);
    app.post('/register', handleRegistration);
    app.post('/dispatch', handleDispatch);

    if (SSL_PRIVATE_KEY_PATH && SSL_CERTIFICATE_PATH) {
        var credentials = {
            key: FS.readFileSync(SSL_PRIVATE_KEY_PATH),
            cert: FS.readFileSync(SSL_CERTIFICATE_PATH),
        };
        server = HTTPS.createServer(credentials, app);
    } else {
        server = app.listen(80);
    }
    createSchema();
}

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

function createSchema() {
    Promise.try(() => {
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
        setTimeout(createSchema, 5000);
    });
}

function handleRegistration(req, res) {
    return Promise.try(() => {
        var registrationId = req.body.registration_id;
        var details = req.body.details || {};
        var domain = req.body.domain;
        var token = req.body.token;
        if (!registrationId) {
            throw new HttpError(400);
        }
        return updateRegistration(registrationId, network, details, domain, token).then((row) => {
            return {
                ctime: Moment(row.ctime).toISOString(),
                atime: Moment(row.atime).toISOString(),
                message_count: row.message_count,
            };
        });
    }).then((results) => {
        sendJSON(results);
    }).catch((err) => {
        sendError(err);
    });
}

function handleDispatch(req, res) {
    return Promise.try(() => {
        var signature = req.body.signature;
        var domain = req.body.domain;
        var messages = req.body.messages;
        if (!signature || !domain || !messages) {
            throw new HttpError(400);
        }
        return confirmSignature(domain, signature).then(() => {
            return checkRateLimit(domain, messages.length).then(() => {
                var recipientTokens = _.flatten(_.map(messages, 'tokens'));
                var validTokens = [];
                var deviceMessageCounts = {};
                var errors = [];
                return findListeningDevices(domain, tokens).each((device) => {
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
                    return updateStatistics(domain, deviceMessageCounts);
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
        sendJSON(results);
    }).catch((err) => {
        sendError(err);
    });
}

/**
 * Set current_domain and current_token of device record
 *
 * @param  {String} registrationId
 * @param  {String} domain
 * @param  {String} token
 *
 * @return {Promise<Object|undefined>}
 */
function updateRegistration(registrationId, network, details, domain, token) {
    var db = Databse.get();
    var sql = `
        UPDATE ${Schema.name}.device
        SET current_domain = $1, current_token = $2
        WHERE registration_id = $3 AND network = $4
        RETURNING *;
    `;
    var params = [ domain, token, registrationId, network ];
    return db.query(sql, params).then((rows) => {
        if (rows.length > 0) {
            return rows[0];
        }
        var sql = `
            INSERT INTO ${Schema.name}.device (
                registration_id,
                network,
                details,
                current_domain,
                current_token
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO UPDATE SET current_domain = $4, current_token = $5
            RETURNING *;
        `;
        var params = [ domain, token, details, registrationId, network ];
        return db.query(sql, params).then((rows) => {
            return rows[0];
        });
    });
}

/**
 * Find rows in device when current domain and token match the ones given
 *
 * @param  {String} domain
 * @param  {String} tokens
 *
 * @return {Promise<Array<Object>>}
 */
function findListeningDevices(domain, tokens) {
    var db = Databse.get();
    var sql = `
        SELECT * FROM ${Schema.name}.device
        WHERE current_domain = $1 AND current_token = ANY($2)
    `;
    var params = [ domain, tokens ];
    return db.query(sql, params).get(0);
}

/**
 * Increment message_count in site and device
 *
 * @param  {String} domain
 * @param  {Object<Number>} messageCounts
 *
 * @return {Promise}
 */
function updateStatistics(domain, messageCounts) {
    // messageCounts is keyed by device ids
    var totalMessageCount = _.sum(_.values(messageCounts));
    if (totalMessageCount === 0) {
        return Promise.resolve();
    }
    var sql = `
        UPDATE ${Schema.name}.site
        SET message_count = message_count + $1
        WHERE domain = $2
    `;
    var params = [ totalMessageCount, domain ];
    return db.execute(sql, params).then((result) => {
        if (result.rowCount === 0) {
            var sql = `
                INSERT INTO ${Schema.name}.site (
                    domain,
                    message_count
                )
                VALUES ($1, $2)
                ON CONFLICT DO UPDATE SET message_count = message_count + $2
            `;
            var params = [ domain, totalMessageCount ];
            return db.execute(sql, params);
        }
    }).then(() => {
        var counts = _.uniq(_.values(messageCounts));
        var idsByCount = _.invertBy(messageCounts);
        return Promise.each(counts, (count) => {
            var ids = _.map(idsByCount[count], parseInt);
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

var messageCountsByDomain = {};
var previousPeriod = getTimeRoundedTo15Min();

/**
 * Reject with HTTP status code 429 if too many messages have been sent from
 * the given domain already
 *
 * @param  {String} domain
 * @param  {Number} additional
 *
 * @return {Promise}
 */
function checkRateLimit(domain, additional) {
    var currentPeriod = getTimeRoundedTo15Min();
    if (previousPeriod !== currentPeriod) {
        messageCountsByDomain = {};
        currentPeriod = previousPeriod;
    }
    var currentCount = messageCountsByDomain[domain] || 0;
    if (currentCount + additional < FIFTEEN_MINUTE_RATE_LIMIT) {
        messageCountsByDomain[domain] = currentCount + additional;
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
        var params = {
          Message: _.pickBy(message, _.toUpper(device.network)),
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
        case 'gcm':
            applicationARN = GCM_ARN;
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
