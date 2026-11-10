# BitBull browser extension

Send the page you're looking at to your local BitBull to review. One click (or **Alt+Shift+B**)
sends a screenshot of what you can see plus the page's text, outline, links, failed requests,
images without alt text and unlabelled form fields. BitBull attaches it to the chat you have open,
as a picture and a Markdown summary, so the chat's model can review it.

## Install (Chrome, Edge, Brave)

1. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → choose this folder (`D:\github\BitBull\browser-extension`).
3. Pin it, click it, open **Connection**: the address is `http://localhost:8787` and the token is
   BitBull's access token (`APP_TOKEN` in BitBull's `.env`). **Test**, then **Save**.

## What it can and can't do

- It reads only the tab you're on, and only when you click (Chrome's `activeTab`): no
  background access to your browsing, and it sends only to BitBull on this computer.
- Pages behind your logins work, because it is your own browser.
- Browser pages (`chrome://…`, the web store, other extensions' pages) can't be read by any
  extension.
- The screenshot is the visible part of the page. Scroll and send again for more.
- Script errors that happened before you clicked aren't visible to an extension, so they're not
  included; failed network requests are.
- What it sends came from a web page: BitBull marks it as material to review, not instructions.
