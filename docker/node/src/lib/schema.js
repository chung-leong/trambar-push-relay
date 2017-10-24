var name = 'push_relay';

exports.tables = `
    CREATE TABLE ${name}.site (
        id serial,
        ctime timestamp NOT NULL DEFAULT NOW(),
        atime timestamp NOT NULL DEFAULT NOW(),
        domain varchar(256) NOT NULL,
        message_count bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ON ${name}.site (domain);

    CREATE TABLE ${name}.device (
        id serial,
        ctime timestamp NOT NULL DEFAULT NOW(),
        atime timestamp NOT NULL DEFAULT NOW(),
        registration_id varchar(1024) NOT NULL,
        network varchar(32) NOT NULL,
        endpoint_arn varchar(2048) NOT NULL,
        details jsonb NOT NULL DEFAULT '{}',
        message_count bigint NOT NULL DEFAULT 0,
        current_domain varchar(256) NOT NULL,
        current_token varchar(40) NOT NULL,
        PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ON ${name}.device (registration_id);
`;
exports.name = name;
