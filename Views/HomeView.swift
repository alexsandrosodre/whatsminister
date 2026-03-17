import SwiftUI

struct HomeView: View {
    
    // MARK: - Propriedades de Estado
    @State private var messageText: String = ""
    @State private var showAlert: Bool = false
    @State private var alertTitle: String = ""
    @State private var alertMessage: String = ""
    
    // MARK: - Corpo da View
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                
                // 1. Título e Descrição
                VStack(alignment: .leading, spacing: 8) {
                    Text("Enviar mensagem para grupo")
                        .font(.headline)
                        .foregroundColor(.primary)
                    
                    TextEditor(text: $messageText)
                        .frame(height: 120)
                        .padding(8)
                        .background(Color(.systemGray6))
                        .cornerRadius(12)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.green.opacity(0.3), lineWidth: 1)
                        )
                }
                .padding(.horizontal)
                
                // 2. Botão de Envio Principal
                Button(action: sendMessage) {
                    HStack {
                        Image(systemName: "paperplane.fill")
                        Text("Enviar mensagem")
                            .fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(messageText.isEmpty ? Color.gray : Color.green)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                    .shadow(radius: 4)
                }
                .disabled(messageText.isEmpty)
                .padding(.horizontal)
                
                Divider()
                    .padding(.vertical, 8)
                
                // 3. Seção de Mensagens Rápidas
                VStack(alignment: .leading, spacing: 12) {
                    Text("Mensagens rápidas")
                        .font(.headline)
                        .padding(.horizontal)
                    
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(MessageModel.quickMessages) { quickMsg in
                                Button(action: {
                                    messageText = quickMsg.content
                                }) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(quickMsg.title)
                                            .font(.subheadline)
                                            .fontWeight(.bold)
                                        Text(quickMsg.content)
                                            .font(.caption)
                                            .lineLimit(2)
                                    }
                                    .padding()
                                    .frame(width: 160, height: 90)
                                    .background(Color.green.opacity(0.1))
                                    .foregroundColor(.green)
                                    .cornerRadius(12)
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                }
                
                Spacer()
            }
            .navigationTitle("WhatsMinister")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        // Limpar mensagem
                        messageText = ""
                    }) {
                        Image(systemName: "trash")
                            .foregroundColor(.red)
                    }
                }
            }
            // Alerta de Erro
            .alert(isPresented: $showAlert) {
                Alert(
                    title: Text(alertTitle),
                    message: Text(alertMessage),
                    dismissButton: .default(Text("OK"))
                )
            }
        }
    }
    
    // MARK: - Ações
    
    private func sendMessage() {
        // Verificar se WhatsApp está instalado
        if !WhatsAppService.shared.isWhatsAppInstalled() {
            showError(title: "WhatsApp não instalado", message: "O WhatsApp não está instalado neste dispositivo.")
            return
        }
        
        // Tentar enviar
        WhatsAppService.shared.sendMessage(message: messageText) { success in
            if !success {
                showError(title: "Erro no envio", message: "Houve um problema ao abrir o WhatsApp. Tente novamente.")
            }
        }
    }
    
    private func showError(title: String, message: String) {
        alertTitle = title
        alertMessage = message
        showAlert = true
    }
}

// MARK: - Preview
struct HomeView_Previews: PreviewProvider {
    static var previews: some View {
        HomeView()
    }
}
