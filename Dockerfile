FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY kopru.js index.html ./
EXPOSE 3002
CMD ["node", "kopru.js"]
