import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, beforeEach } from 'vitest';
import KanbanBoard from '../app/projects/[projectId]/page';
import { vi } from 'vitest';
import { answerConfirm } from './helpers/confirmDialog';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-default' }),
  useRouter: () => ({
    push: vi.fn(),
  }),
  usePathname: () => '/projects/project-default',
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'mock-user-id', email: 'test@example.com' },
    profile: { id: 'mock-user-id', email: 'test@example.com', display_name: 'AM' },
    logout: vi.fn(),
  })
}));

vi.mock('../services/kanbanService', () => ({
  kanbanService: {
    fetchBoardData: vi.fn().mockImplementation(() => {
      console.log('DEBUG MOCK fetchBoardData called!');
      return new Promise(() => {});
    }),
    fetchProjectById: vi.fn().mockImplementation(() => Promise.resolve({ id: 'project-default', name: 'Vývoj MVP' })),
    updateColumnName: vi.fn(),
    createCard: vi.fn(),
    updateCard: vi.fn(),
    archiveCard: vi.fn(),
    deleteCard: vi.fn(),
    moveCard: vi.fn(),
    addActivity: vi.fn(),
    addChecklistItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    deleteChecklistItem: vi.fn(),
    addComment: vi.fn(),
  }
}));

describe('Kanban Board App Unit Tests', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  test('renders the Kanban Board header and columns', async () => {
    render(<KanbanBoard />);
    await screen.findByText('Vývoj MVP');
    
    // RUN 11 (D4): the page H1 is the project's own name (no template hero copy)
    expect(screen.getByRole('heading', { name: 'Vývoj MVP', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Make meaningful progress.')).toBeNull();
    
    // Počátečních 5 sloupců v češtině
    expect(screen.getByTestId('column-title-column-1')).toHaveTextContent('Nápady');
    expect(screen.getByTestId('column-title-column-2')).toHaveTextContent('Naplánováno');
    expect(screen.getByTestId('column-title-column-3')).toHaveTextContent('V průběhu');
    expect(screen.getByTestId('column-title-column-4')).toHaveTextContent('K revizi');
    expect(screen.getByTestId('column-title-column-5')).toHaveTextContent('Hotovo');
  });

  test('allows renaming columns', async () => {
    render(<KanbanBoard />);
    await screen.findByText('Vývoj MVP');
    
    const todoTitle = screen.getByTestId('column-title-column-1');
    expect(todoTitle).toBeInTheDocument();
    
    // Kliknutí na název sloupce pro zapnutí editace
    fireEvent.click(todoTitle);
    
    const input = screen.getByTestId('column-input-column-1') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('Nápady');
    
    // Změna názvu a odeslání stiskem Enter
    fireEvent.change(input, { target: { value: 'Záloha' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    
    // Ověření, že se název aktualizoval
    expect(screen.getByTestId('column-title-column-1')).toHaveTextContent('Záloha');
  });

  test('allows adding a card to a column', async () => {
    render(<KanbanBoard />);
    await screen.findByText('Vývoj MVP');
    
    // Počet karet před přidáním
    const countBadge = screen.getByTestId('column-count-column-1');
    expect(countBadge).toHaveTextContent('2');
    
    // Kliknutí na plus button v hlavičce sloupce
    const addBtn = screen.getByTestId('add-card-btn-column-1');
    fireEvent.click(addBtn);
    
    // Ověření otevření modálního okna v češtině
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Přidat kartu do: Nápady')).toBeInTheDocument();
    
    // Vyplnění formuláře
    const titleInput = screen.getByLabelText('Název *');
    const detailsInput = screen.getByLabelText('Podrobnosti');
    
    fireEvent.change(titleInput, { target: { value: 'New Test Card' } });
    fireEvent.change(detailsInput, { target: { value: 'This is a description of the card' } });
    
    // Odeslání formuláře
    const modal = screen.getByRole('dialog');
    const submitBtn = modal.querySelector('button[type="submit"]') as HTMLButtonElement;
    fireEvent.click(submitBtn);
    
    // Ověření přidání a zavření modálu
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('New Test Card')).toBeInTheDocument();
    expect(screen.getByText('This is a description of the card')).toBeInTheDocument();
    expect(countBadge).toHaveTextContent('3');
  });

  test('allows deleting a card', async () => {
    render(<KanbanBoard />);
    await screen.findByText('Vývoj MVP');
    
    // Ověření, že výchozí karta existuje
    expect(screen.getByText('Návrh mockupů hlavní stránky')).toBeInTheDocument();
    const countBadge = screen.getByTestId('column-count-column-1');
    expect(countBadge).toHaveTextContent('2');
    
    // RUN 11: the card icon ARCHIVES the card and asks first (same dialog as the task drawer); nothing happens before the answer
    const deleteBtn = screen.getByTestId('delete-card-card-1');
    expect(deleteBtn).toHaveAttribute('aria-label', 'Archivovat kartu: Návrh mockupů hlavní stránky');
    fireEvent.click(deleteBtn);
    expect(screen.getByText('Návrh mockupů hlavní stránky')).toBeInTheDocument();
    await answerConfirm({ match: /přesune se do archivu/ });

    // Ověření, že karta z boardu zmizela (archiv)
    await waitFor(() => expect(screen.queryByText('Návrh mockupů hlavní stránky')).not.toBeInTheDocument());
    expect(countBadge).toHaveTextContent('1');
  });

  test('allows editing a card', async () => {
    render(<KanbanBoard />);
    await screen.findByText('Vývoj MVP');
    
    // Kliknutí na kartu card-1
    const cardEl = screen.getByTestId('card-card-1');
    fireEvent.click(cardEl);
    
    // Ověření otevření editačního panelu (draweru)
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Detail úkolu')).toBeInTheDocument();
    
    // Ověření předvyplněného názvu
    const titleInput = screen.getByTestId('drawer-title-input') as HTMLInputElement;
    expect(titleInput.value).toBe('Návrh mockupů hlavní stránky');
    
    // Změna názvu karty
    fireEvent.change(titleInput, { target: { value: 'Návrh mockupů hlavní stránky v2' } });
    fireEvent.blur(titleInput);
    
    // Ověření uložení změny
    expect(screen.getByText('Návrh mockupů hlavní stránky v2')).toBeInTheDocument();
  });
});
