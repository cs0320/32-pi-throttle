# 32-pi-throttle

An extension for the [pi.dev](https://pi.dev) agentic harness, written specifically for use in [Brown's CSCI 0320/1340](https://cs0320.github.io/). It will gradually slow down API requests to avoid (most) rate limiting on the server side. 

This project is likely to change. Installation, usage, and functionality should not be relied upon by automation.

## Installation

Install from within sandbox (if applicable):

`pi install git:github.com/cs0320/32-pi-throttle`

## Usage 

* `/throttle-debug off|on`: debugging spam on/off (default: off).

* `/throttle-log off|on`: logging to a file on/off (default: off). For the moment, the file name and location are constant: `pi-throttle.log` in the current directory.


## AI Use 

This extension was created with help from Claude Opus 5.0. Most especially for: prototyping, testing, and extracting useful information on token counts etc. from API responses. 