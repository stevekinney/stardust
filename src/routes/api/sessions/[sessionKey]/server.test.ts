import { describe, expect, it, vi } from 'vitest';
import { PATCH } from './+server';

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	set: vi.fn(),
	where: vi.fn()
}));

vi.mock('$lib/server/db/client', () => ({
	db: {
		update: mocks.update
	}
}));

// Chain: db.update(...).set(...).where(...) → Promise
mocks.update.mockReturnValue({ set: mocks.set });
mocks.set.mockReturnValue({ where: mocks.where });
mocks.where.mockResolvedValue(undefined);

function makePatchRequest(sessionKey: string, body: unknown, method = 'PATCH') {
	return {
		params: { sessionKey },
		request: new Request(`http://localhost/api/sessions/${sessionKey}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as Parameters<typeof PATCH>[0];
}

describe('PATCH /api/sessions/[sessionKey]', () => {
	it('renames a session and returns 200 with updated name', async () => {
		const response = await PATCH(makePatchRequest('my-session', { name: 'My Project' }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ sessionKey: 'my-session', name: 'My Project' });
		expect(mocks.update).toHaveBeenCalled();
		expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Project' }));
	});

	it('archives a session and returns 200 with archivedAt set', async () => {
		const response = await PATCH(makePatchRequest('my-session', { archived: true }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ sessionKey: 'my-session' });
		expect(typeof body.archivedAt).toBe('string');
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ archivedAt: expect.any(String) })
		);
	});

	it('unarchives a session when archived=false', async () => {
		const response = await PATCH(makePatchRequest('my-session', { archived: false }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.archivedAt).toBeNull();
		expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ archivedAt: null }));
	});

	it('returns 400 when name is an empty string', async () => {
		await expect(PATCH(makePatchRequest('my-session', { name: '   ' }))).rejects.toMatchObject({
			status: 400
		});
	});

	it('returns 400 when name is not a string', async () => {
		await expect(PATCH(makePatchRequest('my-session', { name: 42 }))).rejects.toMatchObject({
			status: 400
		});
	});

	it('returns 400 when sessionKey is invalid', async () => {
		await expect(PATCH(makePatchRequest('../../evil', { name: 'Hack' }))).rejects.toMatchObject({
			status: 400
		});
	});

	it('returns 400 when the request body has no actionable fields', async () => {
		await expect(PATCH(makePatchRequest('my-session', {}))).rejects.toMatchObject({
			status: 400
		});
	});
});
