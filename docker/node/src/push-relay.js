var _ = require('lodash');
var Promise = require('bluebird');
var HTTPS = require('https');
var Express = require('express');
var BodyParser = require('body-parser');
var DNSCache = require('dnscache');
var Request = require('request');
var Database = require('database');
var Schema = require('schema');

DNSCache({ enable: true, ttl: 300, cachesize: 1000 });

var server;

function start() {
    var app = Express();
    app.use(BodyParser.json());
    app.set('json spaces', 2);
    app.post('/register', handleRegistration);
    app.post('/dispatch', handleDispatch);

    var credentials = {
        key: FS.readFileSync(`server.key`),
        cert: FS.readFileSync(`server.crt`),
    };
    server = HTTPS.createServer(credentials, app);
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

function handleRegistration(req, res) {
}

function handleDispatch(req, res) {
    var eventId = req.body.event_id;
    var domain = req.body.domain;
    Database.open().then((db) => {
        var sql = `SELECT * FROM site WHERE domain = $1`;
        return db.query(sql, [ domain ]).get(0).then((server) => {
            if (!server) {
                return;
            }
        });
    });
}
