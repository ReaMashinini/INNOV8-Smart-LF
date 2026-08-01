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
