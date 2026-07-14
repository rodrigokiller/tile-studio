import React from "react";

interface State {
  err: Error | null;
  info: string;
}

/**
 * Rede de seguranca: se QUALQUER coisa no render estourar, mostra o erro (com stack) e um botao
 * de recarregar -- em vez de deixar a tela toda preta/vazia (o "white/black screen of death" do
 * React). Assim o Killer sempre ve o que aconteceu e consegue reabrir sem reiniciar no escuro.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { err: null, info: "" };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    // vai pro console do DevTools tambem (F12), com o componente que estourou
    console.error("Tile Studio: erro de render capturado pelo ErrorBoundary", err, info);
    this.setState({ info: info.componentStack ?? "" });
  }

  render(): React.ReactNode {
    const { err, info } = this.state;
    if (!err) return this.props.children;
    return (
      <div className="errboundary">
        <h1>Algo quebrou na tela 😕</h1>
        <p>
          O Tile Studio pegou um erro no render e evitou a tela preta. Nada foi perdido no disco. Copie a mensagem
          abaixo (ou tire um print) e recarregue.
        </p>
        <pre className="errboundary-msg">
          {err.name}: {err.message}
          {"\n\n"}
          {err.stack ?? ""}
          {info ? "\n\n--- componente ---" + info : ""}
        </pre>
        <div className="errboundary-acts">
          <button className="primary" onClick={() => window.location.reload()}>
            Recarregar
          </button>
          <button className="secondary" onClick={() => this.setState({ err: null, info: "" })}>
            Tentar continuar
          </button>
        </div>
      </div>
    );
  }
}
