import { clientActionsLiveScript } from './client-actions-live.js';
import { clientActionsMarketsScript } from './client-actions-markets.js';
import { clientBindScript } from './client-bind.js';
import { clientRenderListsScript } from './client-render-lists.js';
import { clientRenderStatusScript } from './client-render-status.js';
import { clientStateScript } from './client-state.js';
import { clientUtilsScript } from './client-utils.js';

export const clientScript = [
  clientStateScript,
  clientUtilsScript,
  clientRenderListsScript,
  clientRenderStatusScript,
  clientActionsLiveScript,
  clientActionsMarketsScript,
  clientBindScript
].join('\n');
