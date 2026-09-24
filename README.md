# 32-pi-throttle

An extension for the [pi.dev](https://pi.dev) agentic harness, written specifically for use in [Brown's CSCI 0320/1340](https://cs0320.github.io/). It will gradually slow down (i.e., "throttle") API requests to avoid (most) rate limiting on the server side. 

This project is likely to change. Installation, usage, and functionality should not be relied upon by automation.

## Installation

Install from within sandbox (if applicable) directly from Github:

`pi install git:github.com/cs0320/32-pi-throttle`

Use the same command to update. You should see the usual `git pull` spam afterward, e.g., `remote: Enumerating objects...`. If you only see the following, then the update has **not** occurred:

```
Installing git:github.com/cs0320/32-pi-throttle...
Installed git:github.com/cs0320/32-pi-throttle
```

## Usage 

The extension should apply automatically. When requests are being artificially slowed, you should see a `...Waiting` notification, listing the delay that's been added. Aborting the current request will also abort the added delay.

* `/throttle-debug off|on`: debugging spam on/off (default: off).

* `/throttle-log off|on`: logging to a file on/off (default: off). For the moment, the file name and location are constant: `pi-throttle.log` in the current directory.

* `/throttle-ceiling [tokens]`: show or set the approximate tokens-per-minute ceiling (default: 300000). **Do not change this without talking to course staff first.**

* `/throttle-max-output [tokens|off]`: controls an extension-based cap on output tokens per request. If `off`, the amount configured in `models.json` or elsewhere will be used. **Do not change this without talking to course staff first.**

## AI Use 

This extension was created with help from Claude Opus 5.0. Most especially for: prototyping, testing, and extracting useful information on token counts etc. from API responses. 

## What is *NOT* done? 

Options are not persisted between runs of `pi`. 
