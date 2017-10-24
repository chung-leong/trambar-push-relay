var _ = require('lodash');
var Promise = require('bluebird');
var FS = require('fs');
var PgPool = require('pg-pool')

module.exports = Database;

var config = {
    host: process.env.POSTGRES_HOST,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
};

var pool = new PgPool(config);

function Database(client) {
    this.client = client;
}

Database.get = function() {
    return new Database(pool);
};

Database.prototype.query = function(sql, parameters) {
    return this.execute(sql, parameters).then((result) => {
        return result.rows;
    });
};

Database.prototype.execute = function(sql, parameters) {
    // convert promise to Bluebird variety
    return Promise.resolve(this.client.query(sql, parameters));
};

/**
 * Check if a schema exists
 *
 * @param  {String} schema
 *
 * @return {Promise<Boolean>}
 */
Database.prototype.schemaExists = function(schema) {
    var sql = `SELECT 1 FROM pg_namespace WHERE nspname = $1`;
    return this.query(sql, [ schema ]).get(0).then((row) => {
        return !!row;
    });
}
