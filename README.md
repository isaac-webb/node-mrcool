# NodeJS Interface for MrCool Mini Splits

by Isaac Webb

[![mit license](https://badgen.net/badge/license/MIT/red)](https://github.com/isaac-webb/node-mrcool/blob/master/LICENSE)
[![npm](https://badgen.net/npm/v/node-mrcool)](https://www.npmjs.com/package/node-mrcool)
[![npm](https://badgen.net/npm/dt/node-mrcool)](https://www.npmjs.com/package/node-mrcool)

## Overview

This interface facilitates communication with AC equipment that is connected to
the internet by SmartCielo. This was specifically developed to facilitate
automation of the MRCOOL DIY line of ACs.

### Attribution

The vast majority of this code is either directly from or largely based on the
[`node-smartcielo`](https://github.com/nicholasrobinson/node-smartcielo) package
by [Nicholas Robinson](https://github.com/nicholasrobinson). I forked the repo,
updated/fixed the issues that prevented the package from working, and
republished it.

## Installation

```bash
$ npm install node-mrcool
``` 

## Usage

### Sample Code Execution

```bash
$ node index.js -u <username> -p <password> -i <ip_address> [-v]
```

## References
    
* [MrCool](https://www.mrcool.com/)
* [SmartCielo](https://www.smartcielo.com)

## Notes

* The `-v` option will send all communications via an HTTP proxy running on
  `localhost:8888` for debugging.

Feel free to reach out with issues, fixes, improvements, or any questions.

Best,

Isaac Webb
