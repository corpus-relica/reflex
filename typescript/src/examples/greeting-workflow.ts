// Reflex — Greeting Workflow (programmatic)
// Matches the structure of docs/fixtures/greeting.json

import type { Workflow } from '../types';

/**
 * A simple linear greeting workflow: ASK_NAME → GREET → FAREWELL.
 * This is the programmatic equivalent of docs/fixtures/greeting.json.
 */
export const greetingWorkflow: Workflow = {
  id: 'greeting',
  entry: 'ASK_NAME',
  nodes: {
    ASK_NAME: {
      id: 'ASK_NAME',
      spec: {
        prompt: 'Ask the user for their name',
        outputKey: 'userName',
      },
    },
    GREET: {
      id: 'GREET',
      description: 'Generate a personalized greeting',
      spec: {
        prompt: 'Greet the user by name',
        inputKey: 'userName',
        outputKey: 'greeting',
      },
    },
    FAREWELL: {
      id: 'FAREWELL',
      spec: {
        prompt: 'Say goodbye',
        outputKey: 'farewell',
      },
    },
  },
  edges: [
    { id: 'e-ask-greet', from: 'ASK_NAME', to: 'GREET', event: 'NEXT' },
    {
      id: 'e-greet-farewell',
      from: 'GREET',
      to: 'FAREWELL',
      event: 'NEXT',
    },
  ],
};
