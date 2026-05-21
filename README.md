# INNOV8 SmartLF — Full Original Layout Working Prototype

This version keeps the original one-page website layout, products, cart, pricing, checkout, user dashboard, and admin dashboard, then adds working backend features.

## What is included

- Original product/shop layout preserved
- Original product list preserved
- Bright/dark mode toggle
- Admin has no cart and cannot buy
- Customers can use cart and checkout
- Text-file database: `data/db.json`
- Admin can create users
- Admin can assign QR, NFC, or NFC+QR tags to users
- Built-in QR code generation
- Tag links like `/scan/SLF-ABC123`
- User can add, edit, activate, and deactivate tags
- User can mark order as received
- Admin can update order status: Processing, Shipped, Delivered, Cancelled
- Email sending through Nodemailer if SMTP is configured
- If SMTP is not configured, emails are saved/logged in `data/db.json`
- Scan page asks for phone location
- Location coordinates are only saved when the tag is NFC/NFC+QR and the owner has an active subscription

## Run the project

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Demo logins

Customer:

```text
user@innov8.co.za
demo123
```

Admin:

```text
admin@innov8.co.za
admin123
```

## Email setup

Copy `.env.example` to `.env` and fill in your SMTP details.

For Gmail, use an App Password, not your normal Gmail password.

```env
PORT=3000
BASE_URL=http://localhost:3000
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=your-email@gmail.com
MAIL_PASS=your-app-password
MAIL_FROM="INNOV8 SmartLF <your-email@gmail.com>"
```

Without SMTP, the app still works. Emails are stored in `data/db.json` under `emails`.

## NFC setup later

When you buy NFC stickers/cards, write the generated scan URL to the NFC tag. Example:

```text
http://localhost:3000/scan/SLF-ABC123
```

For real public testing, deploy the app and use the public deployed URL instead of localhost.
