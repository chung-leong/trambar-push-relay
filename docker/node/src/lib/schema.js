var name = 'push_relay';

exports.tables = `
    CREATE TABLE ${name}.site (
        id serial,
        ctime timestamp NOT NULL DEFAULT NOW(),
        atime timestamp NOT NULL DEFAULT NOW(),
        address varchar(256) NOT NULL,
        message_count bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ON ${name}.site (address);

    CREATE TABLE ${name}.device (
        id serial,
        ctime timestamp NOT NULL DEFAULT NOW(),
        atime timestamp NOT NULL DEFAULT NOW(),
        network varchar(32) NOT NULL,
        registration_id varchar(1024) NOT NULL,
        endpoint_arn varchar(2048),
        details jsonb NOT NULL DEFAULT '{}',
        message_count bigint NOT NULL DEFAULT 0,
        current_address varchar(256),
        current_token varchar(64),
        PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ON ${name}.device (registration_id);
`;
exports.name = name;
