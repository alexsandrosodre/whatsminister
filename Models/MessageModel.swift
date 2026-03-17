import Foundation

/// Modelo para representar uma mensagem rápida ou pré-definida.
struct MessageModel: Identifiable {
    let id = UUID()
    let title: String
    let content: String
}

extension MessageModel {
    /// Exemplos de mensagens rápidas sugeridas na documentação.
    static let quickMessages = [
        MessageModel(title: "Escala de Domingo", content: "Olá pessoal, a escala de domingo já está disponível!"),
        MessageModel(title: "Aviso de Reunião", content: "Lembrete: Reunião importante hoje às 19:00."),
        MessageModel(title: "Aviso de Culto", content: "Hoje teremos o nosso culto especial às 20h. Não perca!"),
        MessageModel(title: "Evento", content: "Novo evento programado para o próximo sábado. Fiquem ligados!")
    ]
}
