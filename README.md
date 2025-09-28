# CSS-Fingerprinting-Detective
## Overview
This extension collects and analyzes all CSS rules loaded on a webpage.  
It identifies potential fingerprinting sources (e.g., fonts, @media rules, @container) and sinks (e.g., background-image, @import), then exports the results into a JSON file for further analysis.

---

## Installation (Load the Extension in Chrome)
1. Clone or download this repository.  
2. Open Chrome and go to: chrome://extensions/

3. Enable Developer mode (toggle in the top-right).  
4. Click Load unpacked.  
5. Select the folder containing this repository.  
6. The extension will now appear in your extensions bar.  

---

## Usage
- Open any webpage (e.g., https://google.com).  
- Click the extension’s icon in the Chrome toolbar.  
- The extension will:
  - Inject the script into the page  
  - Collect all CSS rules  
  - Identify fingerprinting-related sources and sinks  
  - Trigger a JSON download containing the results  

---

## File Descriptions
- manifest.json  
Defines the extension (permissions, background, content scripts).  

- background.js  
Runs in the background (service worker).  
  Injects content.js when the extension icon is clicked.  
  Receives CSS dump data and downloads it as a .json file.  

- content.js  
Runs inside the webpage.  
  Collects all CSS rules (including @media, @container, @font-face, etc.).  
  Filters rules into sources and sinks.  
  Builds associations between them.  
  Sends results to background.js.  

## Example Output (JSON snippet)
```json
{
"page": "https://google.com",
"timestamp": 1699999999999,
"sheets": [
 {
   "href": "(inline <style>)",
   "rules": 42,
   "rulesList": [
     {
       "type": "CSSFontFaceRule",
       "selector": "",
       "cssText": "@font-face { font-family: Arial; src: local('Arial'); }",
       "sources": [{ "reason": "heuristic_source" }],
       "sinks": []
     }
   ]
 }
],
"summary": {
 "totalRulesScanned": 500,
 "totalSources": 10,
 "totalSinks": 8,
 "totalAssociations": 6
}
}
