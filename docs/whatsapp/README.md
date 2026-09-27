# Sending PDFs on WhatsApp (WhatsApp Business Cloud API)

Quotations, invoices and engagement letters are sent as a **WhatsApp document** (the PDF
itself) from the firm's WhatsApp Business number. The Audit OS server builds the PDF,
uploads it to WhatsApp (`POST /{phone-number-id}/media`) and sends it
(`POST /{phone-number-id}/messages`). A browser alone cannot do this: `wa.me` links
carry text only.

Without these settings, the WhatsApp form still works in manual mode. It downloads the PDF,
opens the chat, and tells you to drag the file in.

## One-time setup in Meta

1. **Meta Business account.** Go to https://business.facebook.com and create or choose the firm's business.
2. **WhatsApp app.** Go to https://developers.facebook.com, choose My Apps → Create App → Business, then add the
   **WhatsApp** product.
3. **Phone number.** Under WhatsApp → API Setup → add phone number, register the firm's business number.
   - The number must **not** be in use in the WhatsApp or WhatsApp Business phone app. Delete that account first, or use a new number.
   - Copy the **Phone number ID**. This is a long ID, not the phone number.
4. **Permanent token.** In Business Settings → Users → System users:
   - Add a system user with the Admin role.
   - Assign it the app and the WhatsApp account.
   - Click Generate token and select `whatsapp_business_messaging` and `whatsapp_business_management`.
   - Copy the token. It is shown only once.
5. **Message template.** WhatsApp only lets a business *start* a conversation with an approved
   template. In WhatsApp Manager → Message templates → Create:
   - Category: **Utility**
   - Name: e.g. `document_share`, language **English** (`en`)
   - Header: **Document**
   - Body (exactly two variables):
     ```
     Dear {{1}}, please find attached {{2}} from JNS Accounting Solutions. Reply here if you have any questions.
     ```
     `{{1}}` = client name, `{{2}}` = e.g. "Quotation QT-2026-0001".
   - Submit it and wait until its status is **Approved**.
6. **Payment method.** Add one in WhatsApp Manager. Meta charges per conversation; utility rates for India are listed on Meta's pricing page.

## Audit OS settings (`server/.env`, then restart the API)

```
WHATSAPP_TOKEN=<permanent system-user token>
WHATSAPP_PHONE_NUMBER_ID=<phone number ID>
WHATSAPP_TEMPLATE_NAME=document_share
WHATSAPP_TEMPLATE_LANG=en
```

If `WHATSAPP_TEMPLATE_NAME` is empty, the PDF is sent as a plain document with a caption.
WhatsApp accepts that only within 24 hours of the client's last message to you.

## Errors you may see

| Message | Meaning |
|---|---|
| number is not on the allowed test-recipient list | The app is still in development mode. Add the number under API Setup, or publish the app |
| template does not exist or is not approved | Check the template name and language and its approval status |
| parameters do not match | The template body must have exactly `{{1}}` and `{{2}}` |
| access token has expired | Generate a new permanent token |
| free-form message only within 24 hours | Set up the template (step 5) |

WhatsApp accepts the message immediately, but reports delivery later. If a number isn't on WhatsApp, the
message is accepted and then not delivered. Delivery receipts need a webhook, which isn't configured yet.
