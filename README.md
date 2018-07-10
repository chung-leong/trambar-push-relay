Trambar Push Relay
------------------

A Trambar push relay accepts notifications from Trambar servers and sends them
to Amazon's Simple Notification Service (SNS), which in turns send them to
[APNS](https://developer.apple.com/notifications/),
[FCM](https://firebase.google.com/docs/cloud-messaging/), and
[WNS](https://docs.microsoft.com/en-us/windows/uwp/design/shell/tiles-and-notifications/windows-push-notification-services--wns--overview).

## Installation

1. Install Docker and Docker compose:

   `sudo apt-get install docker.io docker-compose`

2. Create the directory `/etc/tpr`.

3. Copy [docker-compose.yml](docker-compose/prod/docker-compose.yml) into `/etc/tpr`.

4. Create .env in `/etc/tpr` based on the [template](dokcer-compose/prod/env-template) file.

5. Change working directory to `/etc/tpr` and start up the relay:

   `sudo docker-compose up -d`
