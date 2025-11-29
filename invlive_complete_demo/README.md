InvLive Demo Full Package
-------------------------

Files:
- index.html (client placeholder)
- admin.html (admin placeholder)
- server.js (backend)
- package.json
- db.json (initial empty DB)
- .env.example

Run:
1. npm install
2. copy .env.example -> .env and fill SMTP/Admin values if you want email notifications
3. node server.js
4. serve index.html/admin.html using a static server (e.g., npx http-server . -p 5500)

