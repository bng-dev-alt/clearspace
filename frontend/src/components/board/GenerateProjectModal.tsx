'use client';

import React, { useState, useEffect } from 'react';
import { X, Sparkles, Check, ChevronDown, ChevronUp, Cpu, Activity, ListChecks, AlertTriangle } from 'lucide-react';
import { aiClient } from '../../services/ai/aiClient';

interface GeneratedTask {
  title: string;
  description: string;
  priority: 'Low' | 'Medium' | 'High' | '';
  estimate?: string;
  acceptanceCriteria?: string[];
  checklist?: string[];
  recommendedColumn: string;
}

export interface GenerateProjectResponse {
  name: string;
  description: string;
  summary: string;
  icon: string;
  accentColor: string;
  recommendedColumns: string[];
  recommendedStack: string[];
  complexity: string;
  estimatedDuration: string;
  recommendedTeamSize: string;
  tags: string[];
  aiRecommendation?: {
    recommendation: string;
    biggestRisk: string;
    focusArea: string;
    mvpScope: string;
  };
  tasks: GeneratedTask[];
}

interface GenerateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: (projectData: GenerateProjectResponse) => Promise<void>;
}

const AVAILABLE_PROJECT_TYPES = [
  { id: 'Web App', label: '🌐 Web App' },
  { id: 'SaaS', label: '☁ SaaS' },
  { id: 'Mobile App', label: '📱 Mobile App' },
  { id: 'AI Agent', label: '🤖 AI Agent' },
  { id: 'API', label: '⚙ API' },
  { id: 'Other', label: '✨ Jiný / Jiné' },
];

const AVAILABLE_STACKS = [
  'React',
  'Next.js',
  'TypeScript',
  'Supabase',
  'PostgreSQL',
  'OpenAI',
  'Anthropic',
  'MCP',
  'n8n',
  'Docker',
  'Other',
];

export default function GenerateProjectModal({
  isOpen,
  onClose,
  onAccept,
}: GenerateProjectModalProps) {
  // Form input states
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  
  // Selected project types (multi-select)
  const [projectTypes, setProjectTypes] = useState<string[]>([]);
  
  // Preferred Stack (multi-select chips)
  const [selectedStack, setSelectedStack] = useState<string[]>([]);
  const [customStack, setCustomStack] = useState('');
  
  // Detail level (Radio Cards: MVP, Standard, Detailed)
  const [detailLevel, setDetailLevel] = useState<'MVP' | 'Standard' | 'Detailed'>('Detailed');
  
  // Task count option (Radio Cards: 5, 10, 20, Custom)
  const [taskCountOption, setTaskCountOption] = useState<'5' | '10' | '20' | 'Custom'>('10');
  const [customTaskCount, setCustomTaskCount] = useState(15);

  // Tracks if the user has manually modified the field to stop auto-prediction
  const [userModified, setUserModified] = useState({
    projectTypes: false,
    stack: false,
    detailLevel: false,
    taskCount: false,
  });

  // AI loading / response states
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedProject, setGeneratedProject] = useState<GenerateProjectResponse | null>(null);

  // Preview 2.0 states
  const [activeTab, setActiveTab] = useState<'overview' | 'architecture' | 'workflow' | 'backlog'>('overview');
  const [expandedTasks, setExpandedTasks] = useState<Record<number, boolean>>({});

  // Escape key listener to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // AI Assisted prefilling - Local heuristic triggers on description change
  const handleDescriptionChange = (val: string) => {
    setProjectDescription(val);
    if (!val.trim()) return;
    const desc = val.toLowerCase();

    // 1. Predict Project Type
    if (!userModified.projectTypes) {
      const predictedTypes: string[] = [];
      if (desc.includes('saas') || desc.includes('software as a service') || desc.includes('předplatné') || desc.includes('stripe') || desc.includes('platb')) {
        predictedTypes.push('SaaS');
      }
      if (desc.includes('web') || desc.includes('stránka') || desc.includes('website') || desc.includes('frontend') || desc.includes('react') || desc.includes('next.js')) {
        predictedTypes.push('Web App');
      }
      if (desc.includes('mobil') || desc.includes('ios') || desc.includes('android') || desc.includes('native') || desc.includes('appka') || desc.includes('telefon')) {
        predictedTypes.push('Mobile App');
      }
      if (desc.includes('ai') || desc.includes('agent') || desc.includes('llm') || desc.includes('gpt') || desc.includes('umělá inteligence') || desc.includes('openai') || desc.includes('claude') || desc.includes('rag')) {
        predictedTypes.push('AI Agent');
      }
      if (desc.includes('api') || desc.includes('backend') || desc.includes('rest') || desc.includes('endpoint') || desc.includes('server') || desc.includes('graphql')) {
        predictedTypes.push('API');
      }

      if (predictedTypes.length > 0) {
        setProjectTypes(predictedTypes);
      }
    }

    // 2. Predict Preferred Stack
    if (!userModified.stack) {
      const predictedStack: string[] = [];
      if (desc.includes('react')) predictedStack.push('React');
      if (desc.includes('next')) predictedStack.push('Next.js');
      if (desc.includes('typescript') || desc.includes('ts')) predictedStack.push('TypeScript');
      if (desc.includes('supabase') || desc.includes('database') || desc.includes('db')) predictedStack.push('Supabase');
      if (desc.includes('postgres') || desc.includes('sql')) predictedStack.push('PostgreSQL');
      if (desc.includes('openai') || desc.includes('gpt')) predictedStack.push('OpenAI');
      if (desc.includes('claude') || desc.includes('anthropic')) predictedStack.push('Anthropic');
      if (desc.includes('mcp') || desc.includes('model context protocol')) predictedStack.push('MCP');
      if (desc.includes('n8n') || desc.includes('automatiz') || desc.includes('workflow')) predictedStack.push('n8n');
      if (desc.includes('docker') || desc.includes('kontejner')) predictedStack.push('Docker');

      // Add logical fallbacks based on words
      if (predictedStack.length === 0) {
        if (desc.includes('web') || desc.includes('saas')) {
          predictedStack.push('React', 'Next.js', 'TypeScript');
        } else if (desc.includes('ai') || desc.includes('agent')) {
          predictedStack.push('OpenAI', 'TypeScript');
        }
      }

      if (predictedStack.length > 0) {
        setSelectedStack(predictedStack);
      }
    }

    // 3. Predict Task Count
    if (!userModified.taskCount) {
      if (desc.includes('mvp') || desc.includes('jednoduch') || desc.includes('simple') || desc.includes('malý') || desc.includes('small')) {
        setTaskCountOption('5');
      } else if (desc.includes('velký') || desc.includes('komplex') || desc.includes('big') || desc.includes('complex') || desc.includes('složit') || desc.includes('podrobn')) {
        setTaskCountOption('20');
      } else {
        setTaskCountOption('10');
      }
    }

    // 4. Predict Detail Level
    if (!userModified.detailLevel) {
      if (desc.includes('mvp') || desc.includes('jednoduch') || desc.includes('simple')) {
        setDetailLevel('MVP');
      } else if (desc.includes('detail') || desc.includes('popis') || desc.includes('specifikace') || desc.includes('hlubok') || desc.includes('deep')) {
        setDetailLevel('Detailed');
      } else {
        setDetailLevel('Standard');
      }
    }
  };

  if (!isOpen) return null;

  // Toggle Type Selection
  const handleToggleProjectType = (typeId: string) => {
    setUserModified((prev) => ({ ...prev, projectTypes: true }));
    setProjectTypes((prev) =>
      prev.includes(typeId) ? prev.filter((id) => id !== typeId) : [...prev, typeId]
    );
  };

  // Toggle Stack Selection
  const handleToggleStack = (tech: string) => {
    setUserModified((prev) => ({ ...prev, stack: true }));
    setSelectedStack((prev) =>
      prev.includes(tech) ? prev.filter((t) => t !== tech) : [...prev, tech]
    );
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectDescription.trim()) {
      setError('Popis projektu je povinný.');
      return;
    }

    setIsLoading(true);
    setError(null);

    // Prepare inputs
    const finalProjectType = projectTypes.length > 0 ? projectTypes.join(', ') : 'SaaS';
    
    let finalStack = selectedStack.filter((t) => t !== 'Other').join(', ');
    if (selectedStack.includes('Other') && customStack.trim()) {
      finalStack += (finalStack ? ', ' : '') + customStack.trim();
    }

    const finalTaskCount = taskCountOption === 'Custom' ? customTaskCount : parseInt(taskCountOption, 10);

    try {
      const data = await aiClient.fetchAi('/api/ai/generate-project', 'Generate Project', {
        projectName,
        projectDescription,
        projectType: finalProjectType,
        technologies: finalStack,
        detailLevel,
        taskCount: finalTaskCount,
      });

      if (!data.parsed || !data.parsed.tasks) {
        throw new Error('AI vrátila neplatnou strukturu projektu.');
      }

      setGeneratedProject(data.parsed);
      setActiveTab('overview');
      setExpandedTasks({});
    } catch (err: unknown) {
      const error = err as Error;
      console.error(error);
      setError(error.message || 'Při generování projektu došlo k neočekávané chybě.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAcceptClick = async () => {
    if (!generatedProject) return;
    setIsLoading(true);
    try {
      await onAccept(generatedProject);
      onClose();
    } catch (err: unknown) {
      const error = err as Error;
      console.error(error);
      setError(error.message || 'Nepodařilo se dokončit uložení projektu.');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTaskAccordion = (index: number) => {
    setExpandedTasks((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 1000 }}>
      <div
        className="modal-content"
        style={{
          maxWidth: generatedProject ? '850px' : '750px',
          width: '95%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: '1.75rem',
          borderRadius: '16px',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="generate-project-studio"
      >
        {/* Modal Header */}
        <div
          className="modal-header"
          style={{
            borderBottom: '1px solid var(--border-color)',
            paddingBottom: '1rem',
            marginBottom: '1.25rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
              }}
            >
              <Sparkles size={16} />
            </div>
            <div>
              <h2
                className="modal-title"
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 800,
                  color: 'var(--dark-navy)',
                  margin: 0,
                }}
              >
                {generatedProject ? 'AI Project Studio - Návrh projektu' : 'AI Project Studio'}
              </h2>
              <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', fontWeight: 600 }}>
                {generatedProject ? 'Zkontrolujte a upravte vygenerovanou architekturu' : 'Zadejte myšlenku a nechte AI navrhnout kompletní backlog'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Zavřít okno"
            style={{ padding: '0.4rem', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Body */}
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: '0.25rem' }}>
          {error && (
            <div
              style={{
                padding: '0.75rem 1.25rem',
                backgroundColor: 'var(--danger-soft)',
                border: '1px solid var(--danger-soft)',
                color: 'var(--danger)',
                borderRadius: '8px',
                fontSize: '0.8rem',
                fontWeight: 600,
                marginBottom: '1.25rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
              data-testid="generate-error-alert"
            >
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div
              data-testid="generate-loading"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '5rem 0',
                gap: '1rem',
              }}
            >
              <div className="ai-pulse-loader" style={{ width: '48px', height: '48px' }} />
              <div
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 750,
                  background: 'var(--accent)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                ✨ AI navrhuje architekturu projektu...
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', textAlign: 'center', maxWidth: '300px', margin: 0 }}>
                Generujeme sloupce, stack, časové odhady, checklisty a akceptační kritéria. Může to trvat až 30 sekund.
              </p>
            </div>
          ) : !generatedProject ? (
            /* guided input form */
            <form onSubmit={handleGenerate} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* project name */}
              <div className="form-group">
                <label htmlFor="studio-project-name" className="form-label" style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Název projektu <span style={{ color: 'var(--gray-text)', fontSize: '0.7rem' }}>(Volitelný)</span>
                </label>
                <input
                  id="studio-project-name"
                  type="text"
                  className="form-input"
                  placeholder="např. Eshop s lokálními potravinami"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  style={{ borderRadius: '10px' }}
                  data-testid="studio-project-name-input"
                />
              </div>

              {/* description */}
              <div className="form-group">
                <label htmlFor="studio-project-desc" className="form-label" style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Popiš svůj nápad a cíle * <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <textarea
                  id="studio-project-desc"
                  className="form-input"
                  placeholder="Popište podrobně, co má projekt dělat. Na základě tohoto popisu AI navrhne sloupce, stack a úkoly. (např. Mobilní aplikace pro vyhledávání a nákup lokálního ovoce...)"
                  rows={4}
                  value={projectDescription}
                  onChange={(e) => handleDescriptionChange(e.target.value)}
                  style={{ borderRadius: '10px', resize: 'vertical', minHeight: '80px' }}
                  required
                  data-testid="studio-project-desc-input"
                />
              </div>

              {/* project type (selectable cards) */}
              <div className="form-group">
                <label className="form-label" style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Typ projektu <span style={{ color: 'var(--gray-text)', fontSize: '0.7rem' }}>(Zvolte jeden nebo více)</span>
                </label>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                    gap: '0.75rem',
                    marginTop: '0.25rem',
                  }}
                >
                  {AVAILABLE_PROJECT_TYPES.map((type) => {
                    const isSelected = projectTypes.includes(type.id);
                    return (
                      <div
                        key={type.id}
                        onClick={() => handleToggleProjectType(type.id)}
                        style={{
                          padding: '0.75rem',
                          border: isSelected ? '2px solid var(--purple-secondary)' : '1px solid var(--border-color)',
                          borderRadius: '10px',
                          backgroundColor: isSelected ? 'var(--accent-soft)' : 'var(--surface)',
                          cursor: 'pointer',
                          textAlign: 'center',
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          color: isSelected ? 'var(--purple-secondary)' : 'var(--dark-navy)',
                          transition: 'all 0.2s',
                          boxShadow: isSelected ? '0 2px 8px var(--accent-soft)' : 'none',
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.borderColor = 'var(--blue-primary)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) e.currentTarget.style.borderColor = 'var(--border-color)';
                        }}
                        data-testid={`project-type-card-${type.id}`}
                      >
                        {type.label}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* preferred stack (chips & text fallback) */}
              <div className="form-group">
                <label className="form-label" style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Preferovaný stack <span style={{ color: 'var(--gray-text)', fontSize: '0.7rem' }}>(Volitelné technologie)</span>
                </label>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    marginTop: '0.25rem',
                    marginBottom: '0.5rem',
                  }}
                >
                  {AVAILABLE_STACKS.map((tech) => {
                    const isSelected = selectedStack.includes(tech);
                    return (
                      <div
                        key={tech}
                        onClick={() => handleToggleStack(tech)}
                        style={{
                          padding: '0.4rem 0.8rem',
                          border: isSelected ? '1px solid var(--blue-primary)' : '1px solid var(--border-color)',
                          borderRadius: '20px',
                          backgroundColor: isSelected ? 'var(--accent-soft)' : 'var(--surface)',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          color: isSelected ? 'var(--blue-primary)' : 'var(--gray-text)',
                          transition: 'all 0.15s',
                        }}
                        data-testid={`stack-chip-${tech}`}
                      >
                        {tech === 'Other' ? '✨ Jiný...' : tech}
                      </div>
                    );
                  })}
                </div>

                {selectedStack.includes('Other') && (
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Zadejte vlastní technologie oddělené čárkou (např. Python, FastAPI, React Native)"
                    value={customStack}
                    onChange={(e) => setCustomStack(e.target.value)}
                    style={{ borderRadius: '10px', marginTop: '0.5rem' }}
                    data-testid="custom-stack-input"
                  />
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
                {/* detail level (radio cards) */}
                <div className="form-group">
                  <label className="form-label" style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Úroveň detailu úkolů
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                    {(['MVP', 'Standard', 'Detailed'] as const).map((level) => {
                      const isSelected = detailLevel === level;
                      const levelDescs = {
                        MVP: 'Pouze stručný popis, rychlá orientace.',
                        Standard: 'Střední detaily, popis + akceptační kritéria.',
                        Detailed: 'Detailní rozpis, akceptační kritéria a checklist.',
                      };
                      return (
                        <div
                          key={level}
                          onClick={() => {
                            setUserModified((prev) => ({ ...prev, detailLevel: true }));
                            setDetailLevel(level);
                          }}
                          style={{
                            padding: '0.6rem 0.8rem',
                            border: isSelected ? '2px solid var(--purple-secondary)' : '1px solid var(--border-color)',
                            borderRadius: '10px',
                            backgroundColor: isSelected ? 'var(--accent-soft)' : 'var(--surface)',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.15rem',
                          }}
                          data-testid={`detail-level-card-${level}`}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <input
                              type="radio"
                              checked={isSelected}
                              readOnly
                              style={{ accentColor: 'var(--purple-secondary)' }}
                            />
                            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>{level}</span>
                          </div>
                          <span style={{ fontSize: '0.65rem', color: 'var(--gray-text)', paddingLeft: '1.3rem' }}>
                            {levelDescs[level]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* task count (radio cards) */}
                <div className="form-group">
                  <label className="form-label" style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Počet úkolů k vygenerování
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                    {(['5', '10', '20', 'Custom'] as const).map((opt) => {
                      const isSelected = taskCountOption === opt;
                      const countLabels = {
                        '5': '5 úkolů (Pouze klíčové MVP)',
                        '10': '10 úkolů (Vyvážený backlog)',
                        '20': '20 úkolů (Kompletní plán realizace)',
                        'Custom': 'Vlastní počet úkolů',
                      };
                      return (
                        <div
                          key={opt}
                          onClick={() => {
                            setUserModified((prev) => ({ ...prev, taskCount: true }));
                            setTaskCountOption(opt);
                          }}
                          style={{
                            padding: '0.6rem 0.8rem',
                            border: isSelected ? '2px solid var(--purple-secondary)' : '1px solid var(--border-color)',
                            borderRadius: '10px',
                            backgroundColor: isSelected ? 'var(--accent-soft)' : 'var(--surface)',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.15rem',
                          }}
                          data-testid={`task-count-card-${opt}`}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <input
                              type="radio"
                              checked={isSelected}
                              readOnly
                              style={{ accentColor: 'var(--purple-secondary)' }}
                            />
                            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                              {countLabels[opt]}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {taskCountOption === 'Custom' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                      <input
                        type="number"
                        className="form-input"
                        min={3}
                        max={30}
                        value={customTaskCount}
                        onChange={(e) => setCustomTaskCount(Math.max(1, parseInt(e.target.value, 10) || 0))}
                        style={{ width: '80px', borderRadius: '10px', padding: '0.4rem' }}
                        data-testid="custom-task-count-input"
                      />
                      <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)' }}>úkolů (maximum 30)</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '1rem',
                  marginTop: '0.5rem',
                  borderTop: '1px solid var(--border-color)',
                  paddingTop: '1.25rem',
                }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    padding: '0.65rem 1.25rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--dark-navy)',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Zrušit
                </button>
                <button
                  type="submit"
                  data-testid="generate-project-submit-btn"
                  style={{
                    padding: '0.65rem 1.5rem',
                    border: 'none',
                    borderRadius: '8px',
                    backgroundColor: 'var(--purple-secondary)',
                    color: '#ffffff',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  <Sparkles size={14} />
                  Generovat projekt
                </button>
              </div>
            </form>
          ) : (
            /* preview 2.0 tab layout */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Tab Navigation */}
              <div
                style={{
                  display: 'flex',
                  borderBottom: '1px solid var(--border-color)',
                  gap: '0.5rem',
                }}
                role="tablist"
              >
                {(['overview', 'architecture', 'workflow', 'backlog'] as const).map((tab) => {
                  const isActive = activeTab === tab;
                  const tabLabels = {
                    overview: '📋 Přehled',
                    architecture: '🏗 Architektura',
                    workflow: '⚙ Workflow',
                    backlog: `📦 Backlog (${generatedProject.tasks?.length || 0})`,
                  };
                  return (
                    <button
                      key={tab}
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(tab)}
                      style={{
                        padding: '0.6rem 1rem',
                        border: 'none',
                        borderBottom: isActive ? '3px solid var(--purple-secondary)' : '3px solid transparent',
                        backgroundColor: 'transparent',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        color: isActive ? 'var(--purple-secondary)' : 'var(--gray-text)',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                      data-testid={`preview-tab-${tab}`}
                    >
                      {tabLabels[tab]}
                    </button>
                  );
                })}
              </div>

              {/* Tab Content Display */}
              <div data-testid="generate-project-preview" style={{ minHeight: '300px' }}>
                {/* 1. OVERVIEW TAB */}
                <div style={{ display: activeTab === 'overview' ? 'flex' : 'none', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* project head card */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '1rem',
                      padding: '1rem',
                      borderRadius: '12px',
                      backgroundColor: 'var(--surface-2)',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '2rem',
                        width: '56px',
                        height: '56px',
                        borderRadius: '10px',
                        backgroundColor: generatedProject.accentColor || 'var(--accent-soft)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {generatedProject.icon || '🚀'}
                    </div>
                    <div>
                      <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                        {generatedProject.name}
                      </h3>
                      <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: '0.15rem 0 0 0' }}>
                        {generatedProject.description}
                      </p>
                    </div>
                  </div>

                  {/* Summary */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <h4 style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--dark-navy)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Architektonické rozhodnutí & Souhrn
                    </h4>
                    <p style={{ fontSize: '0.8rem', color: 'var(--dark-navy)', lineHeight: '1.5', margin: 0, whiteSpace: 'pre-wrap' }}>
                      {generatedProject.summary}
                    </p>
                  </div>

                  {/* AI Recommendation section */}
                  <div
                    style={{
                      padding: '1.25rem',
                      borderRadius: '12px',
                      backgroundColor: 'rgba(236, 173, 10, 0.05)',
                      border: '1px solid rgba(236, 173, 10, 0.2)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                    }}
                  >
                    <h4 style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, textTransform: 'uppercase' }}>
                      <Cpu size={14} />
                      🤖 AI Recommendation
                    </h4>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <div>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase' }}>
                          Hlavní doporučení
                        </span>
                        <p style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', fontWeight: 600, margin: '0.15rem 0 0 0' }}>
                          {generatedProject.aiRecommendation?.recommendation || 'Zaměřit se na rychlé dodání klíčové hodnoty a otestování MVP.'}
                        </p>
                      </div>
                      <div>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase' }}>
                          Největší riziko
                        </span>
                        <p style={{ fontSize: '0.75rem', color: 'var(--danger)', fontWeight: 600, margin: '0.15rem 0 0 0' }}>
                          {generatedProject.aiRecommendation?.biggestRisk || 'Komplexita integrací nebo potenciální technický dluh.'}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', borderTop: '1px solid rgba(236, 173, 10, 0.15)', paddingTop: '0.75rem' }}>
                      <div>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase' }}>
                          Na co se zaměřit
                        </span>
                        <p style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.15rem 0 0 0' }}>
                          {generatedProject.aiRecommendation?.focusArea || 'Zabezpečení uživatelských dat a optimalizace výkonu.'}
                        </p>
                      </div>
                      <div>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase' }}>
                          Rozsah MVP
                        </span>
                        <p style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.15rem 0 0 0' }}>
                          {generatedProject.aiRecommendation?.mvpScope || 'Základní funkční rozhraní a jádro datové vrstvy.'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. ARCHITECTURE TAB */}
                <div style={{ display: activeTab === 'architecture' ? 'flex' : 'none', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* project params */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                    <div style={{ padding: '0.75rem', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-color)', borderRadius: '10px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--gray-text)', fontWeight: 700, textTransform: 'uppercase' }}>Složitost</div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--dark-navy)', fontWeight: 800, marginTop: '0.25rem' }}>
                        {generatedProject.complexity === 'High' ? '🔴 Vysoká' : generatedProject.complexity === 'Medium' ? '🟡 Střední' : '🟢 Nízká'}
                      </div>
                    </div>
                    <div style={{ padding: '0.75rem', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-color)', borderRadius: '10px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--gray-text)', fontWeight: 700, textTransform: 'uppercase' }}>Doba realizace</div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--dark-navy)', fontWeight: 800, marginTop: '0.25rem' }}>
                        📅 {generatedProject.estimatedDuration || '4 týdny'}
                      </div>
                    </div>
                    <div style={{ padding: '0.75rem', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-color)', borderRadius: '10px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--gray-text)', fontWeight: 700, textTransform: 'uppercase' }}>Doporučený tým</div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--dark-navy)', fontWeight: 800, marginTop: '0.25rem' }}>
                        👥 {generatedProject.recommendedTeamSize || '2'} lidé
                      </div>
                    </div>
                  </div>

                  {/* recommended stack */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h4 style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--dark-navy)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Technologický stack
                    </h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {generatedProject.recommendedStack?.map((tech, idx) => (
                        <span
                          key={idx}
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            backgroundColor: 'var(--accent-soft)',
                            color: 'var(--blue-primary)',
                            padding: '0.3rem 0.75rem',
                            borderRadius: '20px',
                          }}
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* tags */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h4 style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--dark-navy)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Tagy projektu
                    </h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {generatedProject.tags?.map((tag, idx) => (
                        <span
                          key={idx}
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            backgroundColor: 'var(--accent-soft)',
                            color: 'var(--purple-secondary)',
                            padding: '0.3rem 0.75rem',
                            borderRadius: '20px',
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 3. WORKFLOW TAB */}
                <div style={{ display: activeTab === 'workflow' ? 'flex' : 'none', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <h4 style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--dark-navy)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Workflow projektu
                    </h4>
                    <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                      Tento projekt bude mít na míru navržené workflow sloupce pro Kanban board:
                    </p>
                  </div>

                  {/* Visual process flowchart flow */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      flexWrap: 'wrap',
                      padding: '1.5rem 1rem',
                      borderRadius: '12px',
                      backgroundColor: 'var(--surface-2)',
                      border: '1px solid var(--border-color)',
                      justifyContent: 'center',
                    }}
                  >
                    {generatedProject.recommendedColumns?.map((colName, idx) => (
                      <React.Fragment key={idx}>
                        {idx > 0 && (
                          <span
                            style={{
                              color: 'var(--gray-text)',
                              fontWeight: 800,
                              fontSize: '1.25rem',
                            }}
                          >
                            ➔
                          </span>
                        )}
                        <div
                          style={{
                            padding: '0.6rem 1.25rem',
                            backgroundColor: 'var(--surface)',
                            border: '2px solid var(--border-color)',
                            borderRadius: '30px',
                            fontSize: '0.8rem',
                            fontWeight: 700,
                            color: 'var(--dark-navy)',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                          }}
                        >
                          <span style={{ color: 'var(--blue-primary)', fontSize: '0.9rem' }}>•</span>
                          {colName}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* 4. BACKLOG TAB */}
                <div style={{ display: activeTab === 'backlog' ? 'flex' : 'none', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-text)', marginBottom: '0.25rem' }}>
                    Vygenerovaný backlog obsahuje {generatedProject.tasks?.length || 0} úkolů. Kliknutím úkol rozbalíte.
                  </div>

                  {/* Task accordion */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      maxHeight: '400px',
                      overflowY: 'auto',
                      paddingRight: '0.25rem',
                    }}
                  >
                    {generatedProject.tasks?.map((task, idx) => {
                      const isExpanded = !!expandedTasks[idx];
                      return (
                        <div
                          key={idx}
                          style={{
                            border: '1px solid var(--border-color)',
                            borderRadius: '10px',
                            overflow: 'hidden',
                            backgroundColor: 'var(--surface)',
                            // Rodič je flex column s overflowY:auto -- bez
                            // flexShrink:0 by flexbox místo scrollování
                            // nerovnoměrně smrskl všechny řádky, aby se
                            // vešly do max-height, a overflow:hidden by ten
                            // smrsklý obsah uřízl (viděl by se jen proužek).
                            flexShrink: 0,
                          }}
                        >
                          {/* Accordion Header */}
                          <div
                            onClick={() => toggleTaskAccordion(idx)}
                            style={{
                              padding: '0.75rem 1rem',
                              backgroundColor: isExpanded ? 'var(--accent-soft)' : 'var(--surface)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              cursor: 'pointer',
                              transition: 'background-color 0.2s',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1 }}>
                              <span style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--purple-secondary)' }}>
                                {idx + 1}.
                              </span>
                              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                                {task.title}
                              </span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                              {task.priority && (
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 700,
                                    padding: '0.15rem 0.45rem',
                                    borderRadius: '4px',
                                    backgroundColor:
                                      task.priority === 'High'
                                        ? 'var(--danger-soft)'
                                        : task.priority === 'Medium'
                                        ? 'var(--warning-soft)'
                                        : 'var(--surface-2)',
                                    color:
                                      task.priority === 'High'
                                        ? 'var(--danger)'
                                        : task.priority === 'Medium'
                                        ? '#d97706'
                                        : '#4b5563',
                                  }}
                                >
                                  {task.priority}
                                </span>
                              )}
                              {task.estimate && (
                                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--gray-text)', backgroundColor: 'var(--surface-2)', padding: '0.15rem 0.45rem', borderRadius: '4px' }}>
                                  ⏱ {task.estimate}
                                </span>
                              )}
                              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--blue-primary)', backgroundColor: 'var(--accent-soft)', padding: '0.15rem 0.45rem', borderRadius: '4px' }}>
                                ⚙ {task.recommendedColumn}
                              </span>
                              {isExpanded ? <ChevronUp size={16} color="var(--gray-text)" /> : <ChevronDown size={16} color="var(--gray-text)" />}
                            </div>
                          </div>

                          {/* Accordion Body */}
                          {isExpanded && (
                            <div
                              style={{
                                padding: '1rem',
                                borderTop: '1px solid var(--border-color)',
                                backgroundColor: 'var(--surface-2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.75rem',
                              }}
                            >
                              {/* Desc */}
                              <div>
                                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase' }}>Popis úkolu</span>
                                <p style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.2rem 0 0 0', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                                  {task.description}
                                </p>
                              </div>

                              {/* Checklist */}
                              {task.checklist && task.checklist.length > 0 && (
                                <div>
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                    <ListChecks size={11} /> Checklist
                                  </span>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.25rem' }}>
                                    {task.checklist.map((item, cidx) => (
                                      <div key={cidx} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--dark-navy)' }}>
                                        <div style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: 'var(--blue-primary)' }} />
                                        {item}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Acceptance Criteria */}
                              {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
                                <div>
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                    <Activity size={11} /> Akceptační kritéria
                                  </span>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.25rem' }}>
                                    {task.acceptanceCriteria.map((item, cidx) => (
                                      <div key={cidx} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--dark-navy)' }}>
                                        <span style={{ color: 'var(--purple-secondary)', fontWeight: 'bold' }}>✓</span>
                                        {item}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '1rem',
                  marginTop: '1rem',
                  borderTop: '1px solid var(--border-color)',
                  paddingTop: '1.25rem',
                }}
              >
                <button
                  type="button"
                  data-testid="generate-discard-btn"
                  onClick={() => {
                    setGeneratedProject(null);
                    setError(null);
                  }}
                  style={{
                    padding: '0.65rem 1.25rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--dark-navy)',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Zahodit a zpět
                </button>
                <button
                  type="button"
                  data-testid="generate-accept-btn"
                  onClick={handleAcceptClick}
                  style={{
                    padding: '0.65rem 1.5rem',
                    border: 'none',
                    borderRadius: '8px',
                    backgroundColor: 'var(--purple-secondary)',
                    color: '#ffffff',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  <Check size={14} />
                  Vytvořit projekt & importovat backlog
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
