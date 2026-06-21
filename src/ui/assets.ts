import { clientScript } from './client-script.js';
import { appHtmlMarkup } from './client-html.js';
import { appCssText } from './client-style.js';

export function appHtml(): string {
  return appHtmlMarkup;
}

export function appScript(uiToken: string): string {
  return `'use strict';

const UI_TOKEN = ${JSON.stringify(uiToken)};

${clientScript}
`;
}

export function appCss(): string {
  return appCssText;
}
