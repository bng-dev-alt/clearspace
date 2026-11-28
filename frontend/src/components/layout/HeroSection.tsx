import { X } from 'lucide-react';

interface HeroSectionProps {
  /** H1 of the project page. */
  projectName: string;
  /** Short real facts about the project (role, members, overdue…); empty items are skipped. */
  facts: Array<string | null | false | undefined>;
  onClose: () => void;
  isCollapsed: boolean;
}

/**
 * Project header (RUN 11, D4): the project's own name and a single line of real facts. Replaces the template hero
 * ("PRODUCT TEAM / Q3", "Make meaningful progress.", "THIS WEEK" that counted ALL tasks) – nothing here is decorative or invented.
 * The collapse button and the stored preference (hide_hero_section) are unchanged.
 */
export default function HeroSection({ projectName, facts, onClose, isCollapsed }: HeroSectionProps) {
  const line = facts.filter(Boolean) as string[];
  return (
    <section className={`app-hero project-header ${isCollapsed ? 'collapsed' : ''}`} style={{ position: 'relative' }}>
      <button type="button" className="hide-hero-btn" onClick={onClose} title="Skrýt hlavičku projektu" aria-label="Skrýt hlavičku projektu" data-testid="hide-hero-btn">
        <X size={16} aria-hidden="true" />
      </button>
      <div className="hero-collapse-inner">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">Projekt</span>
            <h1 className="hero-title" data-testid="project-title">{projectName}</h1>
            {/* always rendered (reserved line): facts arrive with the roster, the header must not jump */}
            <p className="hero-desc project-facts" data-testid="project-facts" aria-live="off">{line.length > 0 ? line.join(' · ') : '\u00a0'}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
