FROM node:6

WORKDIR /opt/trambar

# install dependencies
COPY package.json ./
RUN npm install

# install nodemon
RUN npm -g install nodemon

WORKDIR /opt/trambar/backend/src
