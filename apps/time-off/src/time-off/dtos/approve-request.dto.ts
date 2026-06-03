import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ApproveRequestDto {
  @ApiProperty({
    description: 'ID of the manager approving this request',
    example: 'mgr-456',
  })
  @IsString()
  @IsNotEmpty()
  managerId!: string;
}
