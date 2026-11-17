import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { promptBuilder } from '../services/ai/promptBuilder';
import GenerateTasksModal from '../components/board/GenerateTasksModal';
import { Card, Column } from '../types/kanban';

const mockGenerateContent = vi.fn().mockResolvedValue({
  text: JSON.stringify({
    projectSummary: 'Návrh AI backlogu pro testovací projekt.',
    tasks: [
      {
        title: 'Nový úkol B',
        description: 'Popis B',
        priority: 'High',
        estimate: '4h',
        acceptanceCriteria: ['Kritérium B'],
        checklist: ['Checklist B'],
        recommendedColumn: 'Todo',
      },
      {
        title: 'Existující úkol A',
        description: 'Vylepšený popis A',
        priority: 'Medium',
        estimate: '8h',
        acceptanceCriteria: [],
        checklist: [],
        recommendedColumn: 'In Progress',
      }
    ]
  })
});

// aiClient mluví s /api/ai/* přes přihlášení Supabase (v testech není). UI chování
// testujeme proti pass-through, které jen předá požadavek na (mockovaný) fetch.
vi.mock('../services/ai/aiClient', () => ({
  aiClient: {
    setActiveProject: () => {},
    fetchAi: async (endpoint: string, _feature: string, body: Record<string, unknown>) => {
      const res = await fetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI error');
      return data;
    },
  },
}));

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models = {
      generateContent: mockGenerateContent,
    };
  }
  return {
    GoogleGenAI: MockGoogleGenAI,
  };
});

// Mock Auth
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { display_name: 'Test Uživatel' },
  }),
}));

const mockExistingTasks: Card[] = [
  { id: 'task-1', title: 'Existující úkol A', details: 'Detaily', priority: 'High', checklist: [], comments: [], activities: [] },
];

const mockColumns: Column[] = [
  { id: 'col-1', name: 'Todo', cards: mockExistingTasks },
  { id: 'col-2', name: 'In Progress', cards: [] },
];

describe('AI Generate Tasks Workflow Tests', () => {
  const onImportTasks = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Prompt Builder Tests
  test('promptBuilder.buildBacklogGeneratePrompt compiles input parameters correctly', () => {
    const prompt = promptBuilder.buildBacklogGeneratePrompt(
      'Test Project',
      'This is a description',
      mockColumns,
      mockExistingTasks,
      { taskCount: 5, detailLevel: 'High', technologies: 'React, Vite' }
    );

    expect(prompt.length).toBe(2);
    expect(prompt[0].role).toBe('system');
    expect(prompt[1].role).toBe('user');
    expect(prompt[1].content).toContain('Test Project');
    expect(prompt[1].content).toContain('This is a description');
    expect(prompt[1].content).toContain('Existující úkol A');
    expect(prompt[1].content).toContain('Počet úkolů k vygenerování: 5');
    expect(prompt[1].content).toContain('React, Vite');
  });

  // 2. Server API Route Tests
  // 3. UI Modal Component Tests
  test('GenerateTasksModal renders inputs and handles successful generate and import', async () => {
    // Mock global fetch for route endpoint
    const mockResponse = {
      parsed: {
        projectSummary: 'Návrh AI backlogu pro testovací projekt.',
        tasks: [
          {
            title: 'Nový úkol B',
            description: 'Popis B',
            priority: 'High',
            estimate: '4h',
            acceptanceCriteria: ['Kritérium B'],
            checklist: ['Checklist B'],
            recommendedColumn: 'Todo',
          },
          {
            title: 'Existující úkol A', // Duplicate card
            description: 'Vylepšený popis A',
            priority: 'Medium',
            estimate: '8h',
            acceptanceCriteria: [],
            checklist: [],
            recommendedColumn: 'In Progress',
          }
        ]
      }
    };

    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    render(
      <GenerateTasksModal
        isOpen={true}
        onClose={onClose}
        projectName="Můj Projekt"
        columns={mockColumns}
        existingTasks={mockExistingTasks}
        onImportTasks={onImportTasks}
      />
    );

    // Enter project description
    const descTextarea = screen.getByPlaceholderText(/Popište stručně/);
    fireEvent.change(descTextarea, { target: { value: 'Popis nového e-shopu' } });

    // Submit form to generate
    const generateBtn = screen.getByRole('button', { name: /Generovat úkoly/ });
    fireEvent.click(generateBtn);

    // Verify loading spinner renders
    expect(screen.getByTestId('generate-loading')).toBeInTheDocument();

    // Wait for the render of the preview list
    const preview = await screen.findByTestId('generate-preview');
    expect(preview).toBeInTheDocument();

    // Verify Project Summary and Tasks are displayed
    expect(screen.getByText('Návrh AI backlogu pro testovací projekt.')).toBeInTheDocument();
    expect(screen.getByText('1. Nový úkol B')).toBeInTheDocument();

    // Verify Duplicate Warning shows up for 'Existující úkol A'
    expect(screen.getByText(/Úkol s tímto názvem již na boardu existuje/)).toBeInTheDocument();

    // Select "Create Anyway" for the duplicate
    const createAnywayRadio = screen.getByTestId('dup-create-1');
    fireEvent.click(createAnywayRadio);

    // Import tasks
    const importBtn = screen.getByTestId('generate-accept-btn');
    fireEvent.click(importBtn);

    // Expect callback to have imported two tasks: 'Nový úkol B' and duplicate 'Existující úkol A'
    expect(onImportTasks).toHaveBeenCalledWith(
      [
        {
          title: 'Nový úkol B',
          details: 'Popis B\n\n**Odhadovaný čas:** 4h\n\n### Kritéria akceptace:\n- Kritérium B',
          priority: 'High',
          checklist: ['Checklist B'],
          columnName: 'Todo',
        },
        {
          title: 'Existující úkol A',
          details: 'Vylepšený popis A\n\n**Odhadovaný čas:** 8h',
          priority: 'Medium',
          checklist: [],
          columnName: 'In Progress',
        }
      ],
      [] // No replaces requested since we selected 'Create Anyway'
    );
    expect(onClose).toHaveBeenCalled();

    mockFetch.mockRestore();
  });

  test('GenerateTasksModal handles replace choice for duplicates correctly', async () => {
    const mockResponse = {
      parsed: {
        projectSummary: 'Projekt',
        tasks: [
          {
            title: 'Existující úkol A',
            description: 'Nový popis',
            priority: 'Medium',
            estimate: '2h',
            acceptanceCriteria: [],
            checklist: [],
            recommendedColumn: 'Todo',
          }
        ]
      }
    };

    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    render(
      <GenerateTasksModal
        isOpen={true}
        onClose={onClose}
        projectName="Můj Projekt"
        columns={mockColumns}
        existingTasks={mockExistingTasks}
        onImportTasks={onImportTasks}
      />
    );

    const descTextarea = screen.getByPlaceholderText(/Popište stručně/);
    fireEvent.change(descTextarea, { target: { value: 'Popis' } });

    const generateBtn = screen.getByRole('button', { name: /Generovat úkoly/ });
    fireEvent.click(generateBtn);

    const preview = await screen.findByTestId('generate-preview');
    expect(preview).toBeInTheDocument();

    // Select "Replace" for the duplicate task
    const replaceRadio = screen.getByTestId('dup-replace-0');
    fireEvent.click(replaceRadio);

    // Import tasks
    const importBtn = screen.getByTestId('generate-accept-btn');
    fireEvent.click(importBtn);

    // Expect callback to replace (delete) task-1 and add the new one
    expect(onImportTasks).toHaveBeenCalledWith(
      [
        {
          title: 'Existující úkol A',
          details: 'Nový popis\n\n**Odhadovaný čas:** 2h',
          priority: 'Medium',
          checklist: [],
          columnName: 'Todo',
        }
      ],
      ['task-1'] // We delete task-1!
    );

    mockFetch.mockRestore();
  });

  test('GenerateTasksModal triggers onClose callback when Escape key is pressed', () => {
    render(
      <GenerateTasksModal
        isOpen={true}
        onClose={onClose}
        projectName="Můj Projekt"
        columns={mockColumns}
        existingTasks={mockExistingTasks}
        onImportTasks={onImportTasks}
      />
    );

    // Fire Escape keydown event
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });

    // Expect onClose callback to be called
    expect(onClose).toHaveBeenCalled();
  });
});
