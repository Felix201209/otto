import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type ParkResourcePrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface ParkResourceRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  memberAccount: db.AccountView | null;
  adminPrincipal: ParkResourcePrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function parseMeetingRoomBody(body: Record<string, unknown>) {
  return {
    name: typeof body.name === 'string' ? body.name : '',
    location: typeof body.location === 'string' ? body.location : '',
    capacity: Number(body.capacity),
    equipment: Array.isArray(body.equipment)
      ? body.equipment.filter((item): item is string => typeof item === 'string')
      : [],
    imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : null,
    openingHours: typeof body.openingHours === 'string' ? body.openingHours : null,
    enabled: body.enabled !== false,
  };
}

export async function handleParkResourceRoute({
  path,
  method,
  req,
  res,
  url,
  memberAccount,
  adminPrincipal,
  readBody,
  sendJSON,
}: ParkResourceRouteDeps): Promise<boolean> {
  if (path === '/enterprise/park-resources' && method === 'GET') {
    const park = db.getParkForOrganization(memberAccount!.organizationId);
    const resourceOrganizationId = park?.adminOrganizationId
      || memberAccount!.organizationId;
    sendJSON(res, 200, {
      settings: db.getParkSettings(resourceOrganizationId),
      meetingRooms: db.listParkMeetingRooms(resourceOrganizationId),
      meetingSlots: db.listParkMeetingSlots(resourceOrganizationId),
    });
    return true;
  }

  const handlesParkAdministration = path === '/enterprise/park-settings'
    || path === '/enterprise/park-meeting-rooms'
    || path === '/enterprise/park-meeting-slots'
    || path.startsWith('/enterprise/park-meeting-rooms/');
  if (handlesParkAdministration && adminPrincipal) {
    const park = db.getParkForOrganization(adminPrincipal.organizationId);
    if (!park || park.adminOrganizationId !== adminPrincipal.organizationId) {
      sendJSON(res, 403, { error: '当前企业不是产业园管理方' });
      return true;
    }
  }

  if (path === '/enterprise/park-settings' && method === 'GET') {
    sendJSON(res, 200, {
      settings: db.getParkSettings(adminPrincipal!.organizationId),
    });
    return true;
  }

  if (path === '/enterprise/park-settings' && method === 'PUT') {
    const body = await readBody(req);
    try {
      const parkingTotal = typeof body.parkingTotal === 'number'
        ? body.parkingTotal
        : Number(body.parkingTotal);
      sendJSON(res, 200, {
        settings: db.updateParkSettings(adminPrincipal!.organizationId, {
          parkingTotal,
          parkingNote: typeof body.parkingNote === 'string' ? body.parkingNote : null,
        }),
      });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : '园区设置保存失败',
      });
    }
    return true;
  }

  if (path === '/enterprise/park-meeting-rooms' && method === 'GET') {
    sendJSON(res, 200, {
      meetingRooms: db.listParkMeetingRooms(adminPrincipal!.organizationId, true),
    });
    return true;
  }

  if (path === '/enterprise/park-meeting-rooms' && method === 'POST') {
    const body = await readBody(req);
    try {
      sendJSON(res, 201, {
        meetingRoom: db.createParkMeetingRoom(
          adminPrincipal!.organizationId,
          parseMeetingRoomBody(body),
        ),
      });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : '会议室创建失败',
      });
    }
    return true;
  }

  if (path === '/enterprise/park-meeting-slots' && method === 'GET') {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    try {
      sendJSON(res, 200, {
        meetingSlots: db.listParkMeetingSlots(
          adminPrincipal!.organizationId,
          from,
          to,
        ),
      });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : '会议室时段读取失败',
      });
    }
    return true;
  }

  if (path === '/enterprise/park-meeting-slots' && method === 'PUT') {
    const body = await readBody(req);
    try {
      sendJSON(res, 200, {
        meetingSlot: db.setParkMeetingSlotAvailability(
          adminPrincipal!.organizationId,
          {
            roomId: typeof body.roomId === 'string' ? body.roomId : '',
            date: typeof body.date === 'string' ? body.date : '',
            slotKey: typeof body.slotKey === 'string' ? body.slotKey : '',
            enabled: body.enabled !== false,
          },
        ),
      });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : '会议室时段保存失败',
      });
    }
    return true;
  }

  const meetingRoomRoute = path.match(/^\/enterprise\/park-meeting-rooms\/([^/]+)$/);
  if (meetingRoomRoute && (method === 'PUT' || method === 'DELETE')) {
    let meetingRoomId = '';
    try {
      meetingRoomId = decodeURIComponent(meetingRoomRoute[1]!);
    } catch {
      meetingRoomId = '';
    }
    if (!meetingRoomId) {
      sendJSON(res, 400, { error: '会议室编号不正确' });
      return true;
    }
    try {
      if (method === 'DELETE') {
        db.deleteParkMeetingRoom(adminPrincipal!.organizationId, meetingRoomId);
        sendJSON(res, 200, { status: 'deleted' });
        return true;
      }
      const body = await readBody(req);
      sendJSON(res, 200, {
        meetingRoom: db.updateParkMeetingRoom(
          adminPrincipal!.organizationId,
          meetingRoomId,
          parseMeetingRoomBody(body),
        ),
      });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : '会议室保存失败',
      });
    }
    return true;
  }

  return false;
}
