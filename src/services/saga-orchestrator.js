import pool from './db.js';

const SAGA_DEFINITIONS = {
  agent_birth: {
    steps: ['forge_mint', 'trust_register', 'mind_seed', 'agent_list'],
    compensations: {
      agent_list: async (state) => { /* delist from marketplace */ },
      mind_seed: async (state) => { /* archive seeded memory */ },
      trust_register: async (state) => { /* deactivate DID */ },
      forge_mint: async (state) => { /* deprecate genome */ },
    },
  },
  contract: {
    steps: ['law_create_contract', 'trust_verify_parties', 'mind_record'],
    compensations: {
      mind_record: async (state) => { /* remove contract from memories */ },
      trust_verify_parties: async (state) => { /* revoke verification */ },
      law_create_contract: async (state) => { /* void contract */ },
    },
  },
};

export async function createSaga(type, initialState = {}) {
  const sagaId = `saga_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    'INSERT INTO public.sagas (saga_id, type, state, status) VALUES ($1, $2, $3, $4)',
    [sagaId, type, JSON.stringify(initialState), 'pending']
  );
  return sagaId;
}

export async function advanceSaga(sagaId, stepName, result) {
  const { rows } = await pool.query('SELECT * FROM public.sagas WHERE saga_id = $1', [sagaId]);
  if (!rows[0]) throw new Error('Saga not found');

  const state = rows[0].state;
  state.completedSteps = state.completedSteps || [];
  state.completedSteps.push({ step: stepName, result, at: new Date().toISOString() });

  await pool.query(
    'UPDATE public.sagas SET state = $1, status = $2, updated_at = NOW() WHERE saga_id = $3',
    [JSON.stringify(state), 'in_progress', sagaId]
  );
}

export async function completeSaga(sagaId) {
  await pool.query(
    "UPDATE public.sagas SET status = 'completed', updated_at = NOW() WHERE saga_id = $1",
    [sagaId]
  );
}

export async function compensateSaga(sagaId) {
  const { rows } = await pool.query('SELECT * FROM public.sagas WHERE saga_id = $1', [sagaId]);
  if (!rows[0]) return;

  const saga = rows[0];
  const def = SAGA_DEFINITIONS[saga.type];
  if (!def) return;

  const completedSteps = (saga.state.completedSteps || []).map(s => s.step);

  // Compensate in reverse order
  for (const step of completedSteps.reverse()) {
    if (def.compensations[step]) {
      try {
        await def.compensations[step](saga.state);
      } catch (err) {
        console.error(`Compensation failed for saga ${sagaId} step ${step}:`, err.message);
      }
    }
  }

  await pool.query(
    "UPDATE public.sagas SET status = 'compensated', updated_at = NOW() WHERE saga_id = $1",
    [sagaId]
  );
}

// Background worker
export function startSagaWorker() {
  setInterval(async () => {
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { rows } = await pool.query(
        "SELECT saga_id FROM public.sagas WHERE status = 'in_progress' AND updated_at < $1",
        [fiveMinAgo]
      );
      for (const row of rows) {
        console.log(`[Saga] Compensating stale saga: ${row.saga_id}`);
        await compensateSaga(row.saga_id);
      }
    } catch (err) {
      console.error('[Saga Worker] Error:', err.message);
    }
  }, 60_000);
  console.log('  [Saga] Background worker started (60s interval)');
}
