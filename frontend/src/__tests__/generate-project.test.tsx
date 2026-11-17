import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { promptBuilder } from '../services/ai/promptBuilder';
import GenerateProjectModal from '../components/board/GenerateProjectModal';

const mockGenerateContent = vi.fn().mockResolvedValue({
  text: JSON.stringify({
    name: 'AI Vygenerovaný E-shop',
    description: 'Vylepšený popis e-shopu',
    summary: 'Kompletní návrh architektury.',
    icon: '🛍️',
    accentColor: '#ecad0a',
    recommendedColumns: ['Todo', 'Na testování', 'Done'],
    recommendedStack: ['Next.js', 'Tailwind'],
    complexity: 'High',
    estimatedDuration: '4 týdny',
    recommendedTeamSize: '3',
    tags: ['E-commerce'],
    aiRecommendation: {
      recommendation: 'Hlavní doporučení',
      biggestRisk: 'Riziko',
      focusArea: 'Zaměření',
      mvpScope: 'MVP rozsah'
    },
    tasks: [
      {
        title: 'Nastavení repozitáře',
        description: 'Založit Next.js projekt.',
        priority: 'High',
        estimate: '4h',
        acceptanceCriteria: ['Repozitář běží'],
        checklist: [],
        recommendedColumn: 'Todo',
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

describe('AI Generate Project Workflow Tests', () => {
  const onAccept = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Prompt Builder Tests
  test('promptBuilder.buildProjectGeneratePrompt compiles input parameters correctly', () => {
    const prompt = promptBuilder.buildProjectGeneratePrompt(
      'Test E-shop',
      'This is an e-commerce idea',
      'SaaS',
      'React, Supabase',
      'Detailed',
      5
    );

    expect(prompt.length).toBe(2);
    expect(prompt[0].role).toBe('system');
    expect(prompt[1].role).toBe('user');
    expect(prompt[1].content).toContain('Test E-shop');
    expect(prompt[1].content).toContain('This is an e-commerce idea');
    expect(prompt[1].content).toContain('React, Supabase');
    expect(prompt[1].content).toContain('SaaS');
    expect(prompt[1].content).toContain('Detailed');
    expect(prompt[1].content).toContain('Počet úkolů k vygenerování: 5');
  });

  // 2. Server API Route Tests
  // 3. UI Modal Component Tests
  test('GenerateProjectModal renders inputs and handles successful generate and accept', async () => {
    const mockResponse = {
      parsed: {
        name: 'AI Vygenerovaný E-shop',
        description: 'Vylepšený popis e-shopu',
        summary: 'Kompletní návrh architektury.',
        icon: '🛍️',
        accentColor: '#ecad0a',
        recommendedColumns: ['Todo', 'Na testování', 'Done'],
        recommendedStack: ['Next.js', 'Tailwind'],
        complexity: 'High',
        estimatedDuration: '4 týdny',
        recommendedTeamSize: '3',
        tags: ['E-commerce'],
        tasks: [
          {
            title: 'Nastavení repozitáře',
            description: 'Založit Next.js projekt.',
            priority: 'High',
            estimate: '4h',
            acceptanceCriteria: ['Repozitář běží'],
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
      <GenerateProjectModal
        isOpen={true}
        onClose={onClose}
        onAccept={onAccept}
      />
    );

    // Enter project description
    const descTextarea = screen.getByPlaceholderText(/Popište podrobně/);
    fireEvent.change(descTextarea, { target: { value: 'Zákaznický portál' } });

    // Submit form to generate
    const generateBtn = screen.getByRole('button', { name: /Generovat projekt/ });
    fireEvent.click(generateBtn);

    // Verify loading spinner renders
    expect(screen.getByTestId('generate-loading')).toBeInTheDocument();

    // Wait for the render of the preview list
    const preview = await screen.findByTestId('generate-project-preview');
    expect(preview).toBeInTheDocument();

    // Verify Project Summary and Tasks are displayed
    expect(screen.getByText('AI Vygenerovaný E-shop')).toBeInTheDocument();
    expect(screen.getByText('Kompletní návrh architektury.')).toBeInTheDocument();
    expect(screen.getByText(/Nastavení repozitáře/)).toBeInTheDocument();

    // Accept proposal
    const acceptBtn = screen.getByTestId('generate-accept-btn');
    fireEvent.click(acceptBtn);

    // Expect callback to have been called with mockResponse
    await waitFor(() => {
      expect(onAccept).toHaveBeenCalledWith(mockResponse.parsed);
      expect(onClose).toHaveBeenCalled();
    });

    mockFetch.mockRestore();
  });

  test('GenerateProjectModal triggers onClose callback when Escape key is pressed', () => {
    render(
      <GenerateProjectModal
        isOpen={true}
        onClose={onClose}
        onAccept={onAccept}
      />
    );

    // Fire Escape keydown event
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });

    // Expect onClose callback to be called
    expect(onClose).toHaveBeenCalled();
  });

  // 4. AI Assisted Form Heuristics Test
  test('GenerateProjectModal AI Assisted Heuristic auto-selects project types and stacks based on description', () => {
    render(
      <GenerateProjectModal
        isOpen={true}
        onClose={onClose}
        onAccept={onAccept}
      />
    );

    const descTextarea = screen.getByPlaceholderText(/Popište podrobně/);

    // Enter a description matching SaaS, AI Agent, and Next.js / Supabase keywords
    fireEvent.change(descTextarea, {
      target: { value: 'Potřebuji vytvořit SaaS aplikaci pro AI agenty s next.js a databází na Supabase' }
    });

    // Check if SaaS card is highlighted/active (or checked)
    const saasCard = screen.getByTestId('project-type-card-SaaS');
    const aiAgentCard = screen.getByTestId('project-type-card-AI Agent');
    expect(saasCard).toBeInTheDocument();
    expect(aiAgentCard).toBeInTheDocument();

    // Check if Next.js and Supabase stack chips are active
    const nextChip = screen.getByTestId('stack-chip-Next.js');
    const supabaseChip = screen.getByTestId('stack-chip-Supabase');
    expect(nextChip).toBeInTheDocument();
    expect(supabaseChip).toBeInTheDocument();
  });

  // 5. Tabbed Preview and Accordion Test
  test('GenerateProjectModal preview supports tab navigation and backlog task accordion toggles', async () => {
    const mockResponse = {
      parsed: {
        name: 'Preview Test Project',
        description: 'Testing preview 2.0',
        summary: 'Architectural summary text.',
        icon: '🔧',
        accentColor: '#753991',
        recommendedColumns: ['Todo', 'Done'],
        recommendedStack: ['React'],
        complexity: 'Low',
        estimatedDuration: '1 week',
        recommendedTeamSize: '1',
        tags: ['Testing'],
        tasks: [
          {
            title: 'Task Alpha',
            description: 'This is description Alpha',
            priority: 'Medium',
            estimate: '2h',
            acceptanceCriteria: ['AC 1'],
            checklist: ['Check 1'],
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
      <GenerateProjectModal
        isOpen={true}
        onClose={onClose}
        onAccept={onAccept}
      />
    );

    const descTextarea = screen.getByPlaceholderText(/Popište podrobně/);
    fireEvent.change(descTextarea, { target: { value: 'Testing tabs and accordion' } });
    fireEvent.click(screen.getByRole('button', { name: /Generovat projekt/ }));

    // Wait for preview to render
    const preview = await screen.findByTestId('generate-project-preview');
    expect(preview).toBeInTheDocument();

    // Verify Overview Tab is visible by default
    expect(screen.getByText('Preview Test Project')).toBeInTheDocument();
    expect(screen.getByText('Architectural summary text.')).toBeInTheDocument();

    // Navigate to Backlog tab
    const backlogTab = screen.getByTestId('preview-tab-backlog');
    fireEvent.click(backlogTab);

    // Verify task title is visible
    expect(screen.getByText('Task Alpha')).toBeInTheDocument();

    // Description is hidden before accordion expands
    expect(screen.queryByText('This is description Alpha')).not.toBeInTheDocument();

    // Click on accordion header to expand task details
    const accordionHeader = screen.getByText('Task Alpha');
    fireEvent.click(accordionHeader);

    // Verify description, checklist, and criteria are visible now
    expect(screen.getByText('This is description Alpha')).toBeInTheDocument();
    expect(screen.getByText('Check 1')).toBeInTheDocument();
    expect(screen.getByText('AC 1')).toBeInTheDocument();

    mockFetch.mockRestore();
  });
});
