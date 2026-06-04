import { Module } from '@nestjs/common';
import { HcmController } from './hcm.controller';
import { HcmService } from './hcm.service';

@Module({
  imports: [],
  controllers: [HcmController],
  providers: [HcmService],
})
export class AppModule {}
