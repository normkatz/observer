# observer

Observer is an open-source app that monitors various metrics and processes running on an Ubuntu 22+ server that help identify what is causing slowdown, inaccessibility, or downtime. I developed the initial version for a server that's running Wordpress and CiviCRM.  The reason I started this project was that my Wordpress server was getting bombarded with both internal and external activity and users were complaining that it was down for 5-10 minutes ever hour.  In reality, it was not really down, since I could SSH into it but there were times it would get so locked up that I needed to manually reboot it.

In addition to observing Wordpress and Civi debug/error logs, the app observes CPU, memory, process activity, apache access log, database queries, and other low-level metrics that can catch network activity before it reaches the web server.

The service is running on an EC2 on AWS with a Maria DB hosted on RDS.
I'm using Codex and Claude Code to help me write and debug this app.

If you know of other open source apps that do something similar, please let me know so I can try them out and avoid reinventing the wheel.  Thanks for checking out observer.

## Development foundation

Use **Node.js 26.4.0** and npm:

```bash
npm ci
cp .env.example .env
npm run db:check
npm run db:status
npm run db:migrate
npm test
npm run test:integration
```

Database commands support local MariaDB socket authentication and an explicit
RDS mode using EC2-role access to Secrets Manager and verified TLS.
See [database development](docs/database.md) for migration behavior and tests.
The Apache access-log observer is now implemented and tested locally. See
[Apache testing](docs/apache-testing.md) to run it and generate a bounded burst
from EC2. Linux CPU, process, and memory collectors are implemented; see
[system observers](docs/system-observers.md) and [production setup](docs/production.md).
WordPress/CiviCRM log collectors, query monitoring, and SES delivery remain future work.

```bash
npm start
npm run report
```

Use `.env` to enable the Apache observer and select its log path; the corresponding
`metrics.active` value must also be enabled. Defaults are 15-second sampling and
one-hour routine retention.
