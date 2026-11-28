---
title: Privacy — Touchstone Assay
description: What Touchstone Assay's MCP server, REST routes and chat assistant record about you, what they don't, and who else handles the data.
pubDate: 2026-11-28
---

# Privacy

Last updated 28 November 2026.

Touchstone Assay publishes Dated SIU, the daily benchmark price of verified AI work. This page says what our services record when you use them. It describes what the code does today; if that changes, this page changes with it.

## The MCP server and REST routes

These are `https://mcp.touchstoneassay.com/mcp` and the `/v1/…` routes next to it. No account, API key or sign-in is needed.

**What we record**

- **Every call:** which tool was called, and which listing the link came from (the `?via=` tag, for example `registry` or `mcprush`). A call with no tag is recorded as `direct`.
- **Every paid call, in addition:** the paying wallet's address, the amount, the network, the payment route, Circle's payment reference and the time.
- **Sessions:** if a client opens an MCP session with a `?via=` tag, we remember the tag for that session for 7 days, filed under a one-way hash of the session id, not the id itself.

**What we do not record**

- Request or response bodies, prompts or tool arguments.
- IP addresses, in our own records.
- Anything that names a person. A wallet address is the only identifier, and a payer's address is already public on the blockchains where payments settle.

**How we use it:** to count usage, to see which listing brings paying agents, and to keep bookkeeping records of payments. Our own test wallets are labelled internal, and wallets funded by our own allowances are labelled campaign, so they are not mistaken for outside demand. We do not sell this data or build profiles from it.

**How long:** usage counts are kept for as long as Cloudflare's analytics service keeps them. Payment records are kept as accounting records, and we have not set a deletion date for them.

## The chat assistant on prints.touchstoneassay.com

The prints site has a chat assistant.

- **What is stored:** the messages you type, the assistant's replies, the times, a label for the kind of visitor, and a SHA-256 hash of your IP address, used to limit abuse. The raw IP address is not stored.
- **Who else sees it:** your messages are sent to Anthropic's API so that the assistant can answer.
- **How long:** raw conversations are deleted 90 days after the last message. A weekly summary of common questions is kept longer.
- **Please don't type anything private into it.**

## This website

Touchstone Assay's websites are hosted on Cloudflare, which handles every request to them.

## Others who handle data

- **Cloudflare** runs our servers, our database and our analytics. Cloudflare sees the IP address of every request to our services under its own privacy policy, which is outside our control.
- **Circle** settles the paid calls through Circle Gateway. Circle sees the payment.
- **The blockchains** (Base and Arc) are public: a payment settled there is visible to everyone.
- **Anthropic** receives chat messages, as described above.

## Contact

Questions or deletion requests about the chat assistant, or about anything on this page, go to the contact address in the footer of this site. The code behind everything described here is public: <https://github.com/petrkrulis2022/dated-siu-inference>.
