import UIKit

/// Serviço responsável por gerenciar a comunicação com o WhatsApp via URL Scheme.
class WhatsAppService {
    
    /// Singleton para acesso global ao serviço.
    static let shared = WhatsAppService()
    
    private init() {}
    
    /// Verifica se o WhatsApp está instalado no dispositivo.
    /// - Returns: Bool indicando a disponibilidade do app.
    func isWhatsAppInstalled() -> Bool {
        guard let url = URL(string: "whatsapp://") else { return false }
        return UIApplication.shared.canOpenURL(url)
    }
    
    /// Envia uma mensagem via WhatsApp.
    /// - Parameter message: O texto que será pré-preenchido no WhatsApp.
    /// - Parameter completion: Callback para tratar erros caso o app não esteja instalado.
    func sendMessage(message: String, completion: @escaping (Bool) -> Void) {
        // 1. Limpeza e validação da mensagem
        let trimmedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedMessage.isEmpty else {
            completion(false)
            return
        }
        
        // 2. Codificação para URL (URL Encoding)
        guard let encodedMessage = trimmedMessage.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            completion(false)
            return
        }
        
        // 3. Construção da URL Scheme
        let urlString = "whatsapp://send?text=\(encodedMessage)"
        guard let whatsappURL = URL(string: urlString) else {
            completion(false)
            return
        }
        
        // 4. Tentativa de abrir o aplicativo
        if UIApplication.shared.canOpenURL(whatsappURL) {
            UIApplication.shared.open(whatsappURL, options: [:]) { success in
                completion(success)
            }
        } else {
            // WhatsApp não instalado ou erro ao abrir
            completion(false)
        }
    }
    
    /// Abre um grupo do WhatsApp via link de convite.
    /// - Parameter groupLink: O link de convite do grupo (ex: https://chat.whatsapp.com/ID).
    func openGroup(link: String) {
        guard let url = URL(string: link) else { return }
        if UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
    }
}
