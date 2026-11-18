export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';
export type ProjectRole = 'owner' | 'admin' | 'member' | 'viewer';
export type UserRole = 'Owner' | 'Admin' | 'Member' | 'Viewer';

/**
 * TeamMember = jediná identita člověka napříč aplikací (úroveň Workspace).
 * Projekty na tuto identitu pouze odkazují přes memberIds, nevytvářejí kopie.
 */
export interface TeamMember {
  id: string;
  fullName: string;
  initials: string;
  avatarColor: string;
  email?: string;
  createdAt: string;
  avatarUrl?: string;
  // Release 23: vazba na reálný účet (profiles.id). Vyplněno u vlastníka
  // a v budoucnu u pozvaných uživatelů; null u placeholder kontaktů.
  profileId?: string;
  // Připraveno pro Permissions -- zatím pouze metadata, bez vynucení.
  workspaceRole?: WorkspaceRole;
  role?: string;
  status?: string;
  online?: boolean;
  permissions?: string[];
}

export interface Assignee {
  name: string;
  initials: string;
  color: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface Comment {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface ActivityLog {
  id: string;
  text: string;
  createdAt: string;
}

export interface Card {
  id: string;
  title: string;
  details: string;
  tag?: string;
  priority?: 'Low' | 'Medium' | 'High';
  assignee?: Assignee;
  assignees?: TeamMember[];
  dueDate?: string;
  checklist?: ChecklistItem[];
  comments?: Comment[];
  activities?: ActivityLog[];
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Sémantická role sloupce (R6). Chybí-li, odvodí se ze jména (viz projectIntelligence.columnRole). */
export type ColumnRole = 'todo' | 'doing' | 'review' | 'done';

export interface Column {
  id: string;
  name: string;
  cards: Card[];
  role?: ColumnRole | null;
}

export interface ProjectInvitation {
  id: string;
  projectId: string;
  email: string;
  token: string;
  role: 'owner' | 'member';
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  invitedBy?: string;
  expiresAt: string;
  createdAt: string;
}

export interface ProjectActivityLog {
  id: string;
  projectId: string;
  cardId?: string;
  actorId?: string;
  actorName: string;
  actionType: string;
  entityType: 'task' | 'column' | 'project' | 'member';
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskResource {
  id: string;
  taskId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
  downloadUrl?: string;
}


