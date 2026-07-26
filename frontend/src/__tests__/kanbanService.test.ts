import { describe, test, expect, beforeEach } from 'vitest';
import { kanbanService, Project } from '../services/kanbanService';

describe('Kanban Service Unit Tests (Project Isolation & Seeding)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('fetchBoardData for project-default seeds default columns with cards', async () => {
    const board = await kanbanService.fetchBoardData('project-default');
    
    // Máme 5 sloupců
    expect(board.length).toBe(5);
    
    // První sloupec (Nápady) má výchozí karty
    const ideasCol = board.find(col => col.name === 'Nápady');
    expect(ideasCol).toBeDefined();
    expect(ideasCol!.cards.length).toBeGreaterThan(0);
    expect(ideasCol!.cards[0].title).toBe('Návrh mockupů hlavní stránky');
  });

  test('fetchBoardData for any new project seeds empty columns (no cards)', async () => {
    const customProjId = 'project-custom-123';
    const board = await kanbanService.fetchBoardData(customProjId);
    
    // Máme 5 sloupců
    expect(board.length).toBe(5);
    
    // Všechny sloupce jsou prázdné
    for (const col of board) {
      expect(col.cards.length).toBe(0);
      expect(col.id.startsWith(customProjId)).toBe(true);
    }
  });

  test('createProject initializes project list and seeds an empty board in localStorage', async () => {
    const projectName = 'Nový Testovací Projekt';
    const project = await kanbanService.createProject(projectName);
    
    expect(project.name).toBe(projectName);
    expect(project.id.startsWith('project-')).toBe(true);

    // Projekty jsou uloženy v localStorage
    const storedProjects = JSON.parse(localStorage.getItem('kanban_projects') || '[]');
    expect(storedProjects.length).toBeGreaterThan(0);
    expect(storedProjects[0].id).toBe(project.id);

    // Board pro nový projekt je vytvořen v localStorage a je prázdný
    const storedBoard = JSON.parse(localStorage.getItem(`kanban_board_${project.id}`) || '[]');
    expect(storedBoard.length).toBe(5);
    for (const col of storedBoard) {
      expect(col.cards.length).toBe(0);
    }
  });

  test('operations on one project board do not affect other projects', async () => {
    const projA = await kanbanService.createProject('Projekt A');
    const projB = await kanbanService.createProject('Projekt B');

    // Vytvoříme kartu v Projektu A
    const boardA = await kanbanService.fetchBoardData(projA.id);
    const colA1 = boardA[0];
    
    const newCard = {
      id: 'card-test-id',
      title: 'Karta v projektu A',
      details: 'Popisek',
    };

    await kanbanService.createCard(colA1.id, newCard, 0, projA.id);

    // Ověříme, že v Projektu A je karta přítomna
    const updatedBoardA = await kanbanService.fetchBoardData(projA.id);
    expect(updatedBoardA[0].cards.length).toBe(1);
    expect(updatedBoardA[0].cards[0].title).toBe('Karta v projektu A');

    // Ověříme, že Projekt B zůstal prázdný
    const boardB = await kanbanService.fetchBoardData(projB.id);
    expect(boardB[0].cards.length).toBe(0);
  });

  test('fetchProjectById retrieves project details', async () => {
    const proj = await kanbanService.createProject('Test Proj');
    const fetched = await kanbanService.fetchProjectById(proj.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('Test Proj');

    const defaultProj = await kanbanService.fetchProjectById('project-default');
    expect(defaultProj).toBeDefined();
    expect(defaultProj!.name).toBe('Vývoj MVP');
  });

  test('deleteProject removes project and its local storage board data', async () => {
    const proj = await kanbanService.createProject('Smazat mě');
    
    // Board by měl být naseedován v localStorage
    expect(localStorage.getItem(`kanban_board_${proj.id}`)).toBeDefined();

    // Smažeme projekt
    await kanbanService.deleteProject(proj.id);

    // Projekt by neměl být v seznamu projektů
    const storedProjects = JSON.parse(localStorage.getItem('kanban_projects') || '[]');
    expect((storedProjects as Project[]).find((p) => p.id === proj.id)).toBeUndefined();

    // Board by měl být odstraněn z localStorage
    expect(localStorage.getItem(`kanban_board_${proj.id}`)).toBeNull();
  });

  test('deleteProject throws error when trying to delete default project', async () => {
    await expect(kanbanService.deleteProject('project-default')).rejects.toThrow();
  });
});
