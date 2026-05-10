# Bookmarklet

## Live (recommended for development)

Always loads the latest `dist/pike13-batch.js` from the `main` branch via jsdelivr, with a cache-buster:

```
javascript:(()=>{var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/mnlynam/pike13-batch@latest/dist/pike13-batch.js?'+Date.now();document.body.appendChild(s);})();
```

## Pinned (recommended for daily use)

Loads a specific tagged version. Replace `v1.1.0` with the desired tag:

```
javascript:(()=>{var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/mnlynam/pike13-batch@v1.1.0/dist/pike13-batch.js';document.body.appendChild(s);})();
```

## How to install in Chrome / Edge

1. Show the bookmarks bar (Ctrl+Shift+B).
2. Right-click the bar → **Add page...**
3. Name: `pike13-batch`
4. URL: paste one of the `javascript:` URLs above.
5. Save.

## How to install in Firefox

1. Right-click the bookmarks bar → **New Bookmark...**
2. Name: `pike13-batch`
3. Location: paste the `javascript:` URL.
4. Save.

## Verifying it works

Open any `*.pike13.com` page where you're signed in, click the bookmarklet. The pike13-batch panel should appear in the top-right corner. If nothing happens:

- Open DevTools → Console — you should see no errors. If you see `Refused to load the script ... because it violates the following Content Security Policy directive`, Pike13 has tightened CSP and the loader will need to be wrapped (file an issue).
- Confirm you're on a Pike13 page (`musicplace.pike13.com`, `aeg.pike13.com`, etc.) — the script doesn't load on other domains.
- Confirm jsdelivr can reach the file: `https://cdn.jsdelivr.net/gh/mnlynam/pike13-batch@latest/dist/pike13-batch.js` should return JS in your browser.
