'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchAllPendingRequestPages } = require('./telegram-account-manager');

test('continues paging after a short non-final response', async () => {
  const records = Array.from({ length: 219 }, (_, index) => ({
    userId: index + 1,
    date: 1_700_000_000 + index
  }));
  let calls = 0;
  const requests = await fetchAllPendingRequestPages({
    emptyOffsetUser: { id: 0 },
    getInputUser: async (user) => ({ id: user.id }),
    fetchPage: async ({ offsetUser, limit }) => {
      calls += 1;
      const offsetIndex = offsetUser.id ? records.findIndex((request) => request.userId === offsetUser.id) + 1 : 0;
      const responseLimit = calls === 2 ? Math.min(limit, 99) : limit;
      const importers = records.slice(offsetIndex, offsetIndex + responseLimit);
      return {
        importers,
        users: importers.map(({ userId }) => ({ id: userId, firstName: `User ${userId}` }))
      };
    }
  });

  assert.equal(requests.length, 219);
  assert.equal(requests[218].userId, 219);
  assert.equal(calls, 4);
});

test('stops with an error if pagination cursor does not advance', async () => {
  const importer = { userId: 1, date: 1_700_000_000 };
  await assert.rejects(
    fetchAllPendingRequestPages({
      emptyOffsetUser: { id: 0 },
      getInputUser: async (user) => ({ id: user.id }),
      fetchPage: async () => ({
        importers: [importer],
        users: [{ id: importer.userId }]
      })
    }),
    /pagination|sahifalashi/
  );
});
