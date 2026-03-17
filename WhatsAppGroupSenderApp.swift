import SwiftUI

@main
struct WhatsAppGroupSenderApp: App {
    var body: some Scene {
        WindowGroup {
            HomeView()
        }
    }
}

/*
 IMPORTANTE: Para que o aplicativo possa verificar se o WhatsApp está instalado
 utilizando `UIApplication.shared.canOpenURL`, você deve adicionar a seguinte
 configuração no arquivo `Info.plist` do seu projeto Xcode:

 <key>LSApplicationQueriesSchemes</key>
 <array>
    <string>whatsapp</string>
 </array>
*/
