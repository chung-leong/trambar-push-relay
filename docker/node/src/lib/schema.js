exports.tables = `
    CREATE TABLE site (
        id serial,
        ctime timestamp NOT NULL DEFAULT NOW(),
        atime timestamp NOT NULL DEFAULT NOW(),
        domain varchar(256) NOT NULL,
        message_count bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ON site (domain);

    CREATE TABLE device (
        id serial,
        ctime timestamp NOT NULL DEFAULT NOW(),
        atime timestamp NOT NULL DEFAULT NOW(),
        site_id int NOT NULL,
        user_id int NOT NULL,
        message_count bigint NOT NULL DEFAULT 0,
        registration_id varchar(1024) NOT NULL,
        endpoint_arn varchar(2048) NOT NULL,
        details jsonb NOT NULL DEFAULT '{}',
        PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX ON device (location);
    CREATE UNIQUE INDEX ON device (registration_id);
    CREATE INDEX ON device (site_id);
`;
