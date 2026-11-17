import { Column } from '../../types/kanban';
import { INITIAL_COLUMNS, DEFAULT_MEMBERS } from '../../data/dummyData';
import type { Project } from '../kanbanService';

/**
 * Lokální (demo) úložiště v localStorage -- Release 21.
 *
 * Používá se VÝHRADNĚ, když není nakonfigurován Supabase
 * (hasSupabaseConfig === false). V Supabase režimu se localStorage
 * nikdy nepoužívá jako fallback pro zápis, aby nedocházelo
 * k rozdvojení dat.
 */

const PROJECTS_KEY = 'kanban_projects';

const boardKey = (projectId: string) => `kanban_board_${projectId}`;

export const isDefaultProject = (projectId: string): boolean =>
  projectId === 'project-default' || projectId.startsWith('project-default-');

function readProjects(): Project[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(PROJECTS_KEY);
  return stored ? JSON.parse(stored) : [];
}

export const localStore = {
  getProjects(userId?: string): Project[] {
    if (typeof window === 'undefined') return [];
    const projects = readProjects();

    // Bez user ID vracíme vše (zpětná kompatibilita / host)
    if (!userId) {
      if (projects.length === 0) {
        const defaultProj: Project = {
          id: 'project-default',
          name: 'Vývoj MVP',
          created_at: new Date().toISOString(),
          teamMembers: DEFAULT_MEMBERS,
        };
        projects.push(defaultProj);
        localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
        return [defaultProj];
      }
      return projects;
    }

    const userProjects = projects.filter((p) => p.user_id === userId);
    if (userProjects.length === 0) {
      const defaultProjId = `project-default-${userId}`;
      const defaultProj: Project = {
        id: defaultProjId,
        name: 'Vývoj MVP',
        created_at: new Date().toISOString(),
        user_id: userId,
        teamMembers: DEFAULT_MEMBERS,
      };
      projects.push(defaultProj);
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));

      // Naseedovat board pro tento projekt
      this.getBoard(defaultProjId);

      return [defaultProj];
    }
    return userProjects;
  },

  saveProjects(projects: Project[]): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    }
  },

  addProject(project: Project): void {
    const projects = readProjects();
    projects.unshift(project);
    this.saveProjects(projects);
  },

  removeProject(projectId: string): void {
    const projects = readProjects();
    this.saveProjects(projects.filter((p) => p.id !== projectId));
    if (typeof window !== 'undefined') {
      localStorage.removeItem(boardKey(projectId));
    }
  },

  findProject(projectId: string): Project | null {
    if (isDefaultProject(projectId)) {
      const projects = this.getProjects();
      const found = projects.find((p) => p.id === projectId);
      if (found) return found;
      return {
        id: projectId,
        name: 'Vývoj MVP',
        created_at: new Date().toISOString(),
        teamMembers: [...DEFAULT_MEMBERS],
      };
    }

    const found = readProjects().find((p) => p.id === projectId) || null;
    if (found && (!found.teamMembers || found.teamMembers.length === 0)) {
      found.teamMembers = [...DEFAULT_MEMBERS];
    }
    return found;
  },

  getBoard(projectId: string): Column[] {
    if (typeof window === 'undefined') return INITIAL_COLUMNS;
    const stored = localStorage.getItem(boardKey(projectId));
    if (stored) return JSON.parse(stored);

    const isDefault = isDefaultProject(projectId);
    const seededBoard = INITIAL_COLUMNS.map((col) => ({
      id: isDefault ? col.id : `${projectId}-${col.id}`,
      name: col.name,
      cards: isDefault
        ? col.cards.map((card) => ({ ...card }))
        : [], // Nové boardy začínají prázdné
    }));

    localStorage.setItem(boardKey(projectId), JSON.stringify(seededBoard));
    return seededBoard;
  },

  saveBoard(projectId: string, columns: Column[]): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem(boardKey(projectId), JSON.stringify(columns));
    }
  },

  // --- Project membership (lokální režim, Release 22) ---

  setProjectMembers(projectId: string, memberIds: string[]): void {
    const projects = readProjects();
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      project.memberIds = memberIds;
      this.saveProjects(projects);
    } else if (isDefaultProject(projectId)) {
      // Výchozí projekt nemusí být zatím uložený -> založ minimální záznam
      projects.push({
        id: projectId,
        name: 'Vývoj MVP',
        created_at: new Date().toISOString(),
        memberIds,
      });
      this.saveProjects(projects);
    }
  },
};
