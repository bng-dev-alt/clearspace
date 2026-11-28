import React from 'react';

/**
 * RUN 11 (D1): what the Slack / Telegram pieces are and how they differ, in plain words. Static text that matches the implementation
 * (docs/training/COMMUNICATION_HUB.md §1); no state, no network.
 */
export default function ChatModesExplainer() {
  return (
    <details className="settings-explainer" data-testid="chat-modes-explainer">
      <summary>Jak spolu souvisí Slack, Telegram a ClearSpace</summary>
      <table className="settings-explainer-table">
        <thead>
          <tr><th scope="col">Režim</th><th scope="col">Slack</th><th scope="col">Telegram</th><th scope="col">Kdo to vidí</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Osobní oznámení</th>
            <td>aplikace „ClearSpace oznámení“ píše jen vám (soukromá zpráva)</td>
            <td>bot pro oznámení v soukromém chatu s vámi</td>
            <td>jen vy</td>
          </tr>
          <tr>
            <th scope="row">Kanály a skupiny projektu</th>
            <td>aplikace „ClearSpace Projekty“ v kanálech, kam ji pozvete</td>
            <td>bot Relay ve skupinách, kam ho přidáte; vidí jen příkazy pro sebe a odpovědi na své zprávy</td>
            <td>členové kanálu / skupiny</td>
          </tr>
          <tr>
            <th scope="row">Project Intelligence nad chatem</th>
            <td>čte jen kanály, u kterých to správce projektu výslovně zapne</td>
            <td>bot Cortex jen čte potvrzenou skupinu („Celá komunikace“), nikdy nepíše</td>
            <td>AI projektu; vypnutí zprávy smaže</td>
          </tr>
          <tr>
            <th scope="row">Moje chat účty</th>
            <td colSpan={2}>propojením prokážete, že účet ve Slacku / Telegramu patří vám – úkoly a odpovědi z chatu se pak ukládají pod vaším jménem</td>
            <td>členové projektu vidí autora</td>
          </tr>
        </tbody>
      </table>
      <p className="settings-hint">Kanál nebo skupinu propojíte s projektem v projektu → Integrace. Každé propojení se potvrzuje kódem v ClearSpace a dá se kdykoli odpojit.</p>
    </details>
  );
}
