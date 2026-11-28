FROM node:18-alpine

WORKDIR /app

# Salin dependencies backend dan install
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Salin seluruh isi proyek (termasuk folder frontend)
COPY . .

EXPOSE 3000

CMD ["node", "backend/server.js"]
