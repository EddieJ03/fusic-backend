FROM node:14-slim

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 8000

CMD ["node", "index.js"]